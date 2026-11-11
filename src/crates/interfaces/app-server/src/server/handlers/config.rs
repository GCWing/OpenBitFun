use crate::agent::{config_get_error, openbitfun_error};
use crate::role::{AppClient, AppServer};
use crate::schema::*;
use crate::server::wire;
use agent_client_protocol::{Builder, HandleDispatchFrom};

pub(in crate::server) fn builder() -> Builder<AppServer, impl HandleDispatchFrom<AppClient>> {
    AppServer
        .builder()
        .name("config handlers")
        .on_receive_request(
            async move |_: GetAgentProfileConfigsMessage, responder, _cx| {
                let result = openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_views()
                    .await
                    .map(|profiles| GetAgentProfileConfigsResponse {
                        profiles: profiles
                            .into_iter()
                            .map(|(id, profile)| (id, wire::agent_profile_view(profile)))
                            .collect(),
                    })
                    .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: GetAgentProfileConfigMessage, responder, _cx| {
                let result = openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_view(&request.agent_id)
                    .await
                    .map(|profile| GetAgentProfileConfigResponse(wire::agent_profile_view(profile)))
                    .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_: GetModelConfigsMessage, responder, _cx| {
                let result = async {
                    let service = openbitfun_core::service::config::get_global_config_service().await?;
                    let models = service.get_ai_models().await?;
                    models
                        .into_iter()
                        .map(wire::model_config)
                        .collect::<Result<Vec<_>, _>>()
                        .map_err(openbitfun_core::OpenBitFunError::from)
                }
                .await
                .map(|models| GetModelConfigsResponse { models })
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: GetConfigMessage, responder, _cx| {
                log::debug!("server getConfig request: {:?}", request);
                let result = async {
                    let service = openbitfun_core::service::config::get_global_config_service().await?;
                    service
                        .get_config::<serde_json::Value>(request.path.as_deref())
                        .await
                }
                .await
                .map(GetConfigResponse)
                .map_err(config_get_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: GetConfigsMessage, responder, _cx| {
                let result = async {
                    let service = openbitfun_core::service::config::get_global_config_service().await?;
                    let mut configs = std::collections::BTreeMap::new();
                    for path in request.paths {
                        if configs.contains_key(&path) {
                            continue;
                        }
                        let value = service
                            .get_config::<serde_json::Value>(Some(path.as_str()))
                            .await?;
                        configs.insert(path, value);
                    }
                    Ok(configs)
                }
                .await
                .map(|configs| GetConfigsResponse { configs })
                .map_err(config_get_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetConfigMessage, responder, _cx| {
                let result = async {
                    let service = openbitfun_core::service::config::get_global_config_service().await?;
                    service
                        .set_config::<serde_json::Value>(&request.path, request.value)
                        .await
                }
                .await
                .map(|()| SetConfigResponse {})
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SaveCloudSpeechConfigMessage, responder, _cx| {
                let result = async {
                    let service = openbitfun_core::service::config::get_global_config_service().await?;
                    service
                        .save_cloud_speech_config(
                            openbitfun_core::service::config::SaveCloudSpeechConfigRequest {
                                config_id: request.request.config_id,
                                preset: request.request.preset,
                                name: request.request.name,
                                base_url: request.request.base_url,
                                request_url: request.request.request_url,
                                model_name: request.request.model_name,
                                api_key: request.request.api_key,
                            },
                        )
                        .await
                }
                .await
                .map(|result| {
                    SaveCloudSpeechConfigResponse(SaveCloudSpeechConfigResult {
                        model_id: result.model_id,
                        created: result.created,
                    })
                })
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: GetWebSearchCredentialStatusMessage, responder, _cx| {
                let result = openbitfun_core::service::web_search::get_web_search_credential_status(
                    &request.request.provider,
                )
                .await
                .map(|status| {
                    GetWebSearchCredentialStatusResponse(WebSearchCredentialStatus {
                        provider: status.provider,
                        configured: status.configured,
                    })
                })
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SaveWebSearchCredentialMessage, responder, _cx| {
                let result = openbitfun_core::service::web_search::save_web_search_credential(
                    openbitfun_core::service::web_search::SaveWebSearchCredentialRequest {
                        provider: request.request.provider,
                        secret: request.request.secret,
                    },
                )
                .await
                .map(|status| {
                    SaveWebSearchCredentialResponse(WebSearchCredentialStatus {
                        provider: status.provider,
                        configured: status.configured,
                    })
                })
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ClearWebSearchCredentialMessage, responder, _cx| {
                let result = openbitfun_core::service::web_search::clear_web_search_credential(
                    openbitfun_core::service::web_search::ClearWebSearchCredentialRequest {
                        provider: request.request.provider,
                    },
                )
                .await
                .map(|status| {
                    ClearWebSearchCredentialResponse(WebSearchCredentialStatus {
                        provider: status.provider,
                        configured: status.configured,
                    })
                })
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_: GetDecisionModelCredentialStatusMessage, responder, _cx| {
                let result = openbitfun_core::service::decision_model::get_credential_status()
                    .await
                    .map(|status| {
                        GetDecisionModelCredentialStatusResponse(DecisionModelCredentialStatus {
                            configured: status.configured,
                        })
                    })
                    .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SaveDecisionModelCredentialMessage, responder, _cx| {
                let result = openbitfun_core::service::decision_model::save_credential(
                    openbitfun_core::service::decision_model::SaveDecisionModelCredentialRequest {
                        secret: request.request.secret,
                    },
                )
                .await
                .map(|status| {
                    SaveDecisionModelCredentialResponse(DecisionModelCredentialStatus {
                        configured: status.configured,
                    })
                })
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_: ClearDecisionModelCredentialMessage, responder, _cx| {
                let result = openbitfun_core::service::decision_model::clear_credential()
                    .await
                    .map(|status| {
                        ClearDecisionModelCredentialResponse(DecisionModelCredentialStatus {
                            configured: status.configured,
                        })
                    })
                    .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |_: ValidateConfigMessage, responder, _cx| {
                let result = async {
                    let service = openbitfun_core::service::config::get_global_config_service().await?;
                    let validation = service.validate_config().await?;
                    serde_json::to_value(validation).map_err(openbitfun_core::OpenBitFunError::from)
                }
                .await
                .map(ValidateConfigResponse)
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: SetAgentProfileConfigMessage, responder, _cx| {
                let result = async {
                    openbitfun_core::service::config::mode_config_canonicalizer::persist_agent_profile_from_value(
                        &request.agent_id,
                        request.config,
                    )
                    .await?;
                    openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_view(
                        &request.agent_id,
                    )
                    .await
                }
                .await
                .map(|profile| SetAgentProfileConfigResponse(wire::agent_profile_view(profile)))
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            async move |request: ResetAgentProfileConfigMessage, responder, _cx| {
                let result = async {
                    openbitfun_core::service::config::mode_config_canonicalizer::reset_agent_profile_to_default(
                        &request.agent_id,
                    )
                    .await?;
                    openbitfun_core::service::config::mode_config_canonicalizer::get_agent_profile_view(
                        &request.agent_id,
                    )
                    .await
                }
                .await
                .map(|profile| ResetAgentProfileConfigResponse(wire::agent_profile_view(profile)))
                .map_err(openbitfun_error);
                responder.respond_with_result(result)
            },
            agent_client_protocol::on_receive_request!(),
        )
}
