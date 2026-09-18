use std::sync::Arc;

use agent_client_protocol::{Builder, Error, HandleDispatchFrom};
use openbitfun_agent_runtime::sdk::AgentSessionRestoreRequest;
use openbitfun_app_server_protocol::session::{
    CancelLineageRequest, CancelLineageResponse, CompactSessionRequest, CompactSessionResponse,
    InspectLineageRequest, InspectLineageResponse, ReadTranscriptRequest, ReadTranscriptResponse,
    RedoSessionRequest, ReloadContextRequest, ReloadContextResponse, ResolveWorkspaceRequest,
    ResolveWorkspaceResponse, RevertSessionResponse, SessionLineageRequest, SessionLineageResponse,
    SessionUsageRequest, SessionUsageResponse, SyncSessionRequest, SyncSessionResponse,
    UndoSessionRequest, WaitForSettlementRequest, WaitForSettlementResponse,
};

use crate::agent::{runtime_call, OpenBitFunAppRuntime};
use crate::role::{AppClient, AppServer};
use crate::schema::*;
use crate::server::wire;

pub(in crate::server) fn builder(
    runtime: Arc<OpenBitFunAppRuntime>,
) -> Builder<AppServer, impl HandleDispatchFrom<AppClient>> {
    AppServer
        .builder()
        .name("session handlers")
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: RenameSessionMessage, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .rename_session(request.0)
                            .await
                            .map(|()| RenameSessionResponse {})
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: SetSessionArchivedMessage, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .set_session_archived(request.0)
                            .await
                            .map(|()| SetSessionArchivedResponse {})
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: UpdateSessionModelMessage, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .update_session_model(request.0)
                            .await
                            .map(|()| UpdateSessionModelResponse {})
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: UpdateSessionModeMessage, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .update_session_mode(request.0)
                            .await
                            .map(|()| UpdateSessionModeResponse {})
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: ForkSessionMessage, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .fork_session(request.0)
                            .await
                            .map(ForkSessionResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: ForkSessionAtTurnMessage, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .fork_session_at_turn(request.0)
                            .await
                            .map(ForkSessionResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: ForkSessionBeforeTurnMessage, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .fork_session_before_turn(request.0)
                            .await
                            .map(ForkSessionResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: RestoreSessionMessage, responder, _cx| {
                    let session_id = request.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .restore_session(wire::restore_session_request(request))
                            .await
                            .map(wire::restore_session_response)
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: SyncSessionRequest, responder, _cx| {
                    let session_id = request.session_id.clone();
                    let restored = runtime
                        .runtime()
                        .restore_session(AgentSessionRestoreRequest {
                            workspace_id: request.workspace_id,
                            workspace_path: request.workspace_path,
                            session_id: request.session_id,
                            include_internal: request.include_internal,
                            remote_connection_id: request.remote_connection_id,
                            remote_ssh_host: request.remote_ssh_host,
                        })
                        .await
                        .map_err(|error| {
                            OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                        })?;
                    let transcript = runtime_call(
                        runtime
                            .runtime()
                            .read_session_transcript(
                                openbitfun_runtime_ports::SessionTranscriptRequest {
                                    session_id: session_id.clone(),
                                    turn_id: None,
                                },
                            )
                            .await,
                    )?;
                    let workspace_binding = runtime_call(
                        runtime
                            .runtime()
                            .resolve_session_workspace_binding(
                                openbitfun_runtime_ports::AgentSessionWorkspaceRequest {
                                    session_id: session_id.clone(),
                                },
                            )
                            .await,
                    )?
                    .ok_or_else(|| {
                        Error::internal_error().data("Session workspace binding is unavailable")
                    })?;
                    let pending_permissions = runtime
                        .runtime()
                        .pending_permission_requests()
                        .unwrap_or_default()
                        .into_iter()
                        .filter(|permission| permission.session_id == session_id)
                        .collect();

                    responder.respond(SyncSessionResponse {
                        session: restored.session,
                        state: wire::session_state(restored.state),
                        transcript,
                        workspace_binding,
                        pending_permissions,
                    })
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: ReadTranscriptRequest, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .read_session_transcript(request.0)
                            .await
                            .map(ReadTranscriptResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: ResolveWorkspaceRequest, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .resolve_session_workspace_binding(request.0)
                            .await
                            .map(ResolveWorkspaceResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: CompactSessionRequest, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .start_session_compaction(request.0)
                            .await
                            .map(CompactSessionResponse)
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: UndoSessionRequest, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .undo_session(request.0)
                            .await
                            .map(RevertSessionResponse)
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: RedoSessionRequest, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .redo_session(request.0)
                            .await
                            .map(RevertSessionResponse)
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: ReloadContextRequest, responder, _cx| {
                    let port = runtime.context_reload().ok_or_else(|| {
                        Error::internal_error().data("session context reload is unavailable")
                    })?;
                    port.reload_session_context(request.0)
                        .await
                        .map_err(|error| Error::internal_error().data(error.message))?;
                    responder.respond(ReloadContextResponse {})
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: SessionUsageRequest, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .generate_session_usage(request.0)
                            .await
                            .map(SessionUsageResponse)
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: WaitForSettlementRequest, responder, _cx| {
                    let session_id = request.0.session_id.clone();
                    responder.respond_with_result(
                        runtime
                            .runtime()
                            .wait_for_turn_settlement(request.0)
                            .await
                            .map(|_| WaitForSettlementResponse {})
                            .map_err(|error| {
                                OpenBitFunAppRuntime::session_runtime_error(&session_id, error)
                            }),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: SessionLineageRequest, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .get_session_lineage(request.0)
                            .await
                            .map(SessionLineageResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let runtime = runtime.clone();
                async move |request: InspectLineageRequest, responder, _cx| {
                    responder.respond_with_result(runtime_call(
                        runtime
                            .runtime()
                            .read_lineage_session_transcript(request.0)
                            .await
                            .map(InspectLineageResponse),
                    ))
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: CancelLineageRequest, responder, _cx| {
                responder.respond_with_result(runtime_call(
                    runtime
                        .runtime()
                        .cancel_lineage_session(request.0)
                        .await
                        .map(CancelLineageResponse),
                ))
            },
            agent_client_protocol::on_receive_request!(),
        )
}
