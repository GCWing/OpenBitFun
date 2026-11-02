use super::RoundExecutionClient;
use crate::agentic::execution::round_executor::{
    tests::{retry_test_success, test_round_context, test_round_executor, RetryTestServer},
    ModelRoundLifecycle,
};
use crate::infrastructure::ai::account_client_source::{
    AccountClient, AccountClientFuture, AccountClientSource,
};
use crate::infrastructure::ai::channel_client_source::PreparedChannel;
use crate::infrastructure::ai::AIClient;
use openbitfun_agent_runtime::account_routing::AccountPolicy;
use openbitfun_core_types::{Message as AIMessage, ModelAccountOrigin};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

#[derive(Debug)]
struct SlotAccountSource {
    policy: AccountPolicy,
    client: Arc<AIClient>,
    origin: ModelAccountOrigin,
    resolved: AtomicUsize,
    completed: AtomicUsize,
}

impl AccountClientSource for SlotAccountSource {
    fn policy(&self) -> &AccountPolicy {
        &self.policy
    }

    fn resolve<'a>(
        &'a self,
        _excluded: &'a [String],
        required: Option<&'a ModelAccountOrigin>,
    ) -> AccountClientFuture<'a> {
        Box::pin(async move {
            if let Some(required) = required {
                assert_eq!(required, &self.origin);
            }
            self.resolved.fetch_add(1, Ordering::SeqCst);
            Ok(Some(AccountClient {
                client: self.client.clone(),
                origin: self.origin.clone(),
                credential_revision: 7,
            }))
        })
    }

    fn resolve_for_request<'a>(
        &'a self,
        excluded: &'a [String],
        required: Option<&'a ModelAccountOrigin>,
        lineage: Option<&'a str>,
    ) -> AccountClientFuture<'a> {
        assert_eq!(lineage, Some("smart-slot-lineage"));
        self.resolve(excluded, required)
    }

    fn accepted(&self, origin: &ModelAccountOrigin) {
        assert_eq!(origin, &self.origin);
        self.completed.fetch_add(1, Ordering::SeqCst);
    }
}

fn slot(server: &RetryTestServer, id: &str) -> (RoundExecutionClient, Arc<SlotAccountSource>) {
    let mut client = (*server.client()).clone();
    client.config.model = format!("{id}-wire-model");
    let client = Arc::new(client);
    let origin = ModelAccountOrigin {
        provider: "fixture".into(),
        account_id: format!("{id}-account"),
        upstream_account_id: Some(format!("{id}-seat")),
    };
    let source = Arc::new(SlotAccountSource {
        policy: AccountPolicy::Fixed(origin.account_id.clone()),
        client: client.clone(),
        origin: origin.clone(),
        resolved: AtomicUsize::new(0),
        completed: AtomicUsize::new(0),
    });
    (
        RoundExecutionClient::new(
            id.into(),
            PreparedChannel {
                model_id: id.into(),
                client,
                account_source: Some(source.clone()),
                origin: Some(origin),
                credential_revision: Some(7),
            },
            None,
        ),
        source,
    )
}

fn context() -> crate::agentic::execution::types::RoundContext {
    let mut context = test_round_context();
    context.model_request_context.prompt_cache_route_key = Some("smart-slot-lineage".into());
    context
}

#[tokio::test]
async fn smart_slot_first_economy_replaces_the_prepared_primary_on_the_wire() {
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let (mut primary, primary_source) = slot(&server, "primary");
    let (mut economy, economy_source) = slot(&server, "economy");
    let mut context = context();
    // The turn was admitted on primary before the Router selected economy.
    let admitted = primary.take_for_round();
    context.account_client_source = admitted.account_source;
    context.channel_client_source = admitted.channel_source;
    context.prepared_model = admitted.prepared_model;
    let client = economy.take_for_round().install(&mut context);
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        test_round_executor().execute_round(
            client,
            context,
            vec![AIMessage::user("Inspect synthetic history".into())],
            None,
            None,
        ),
    )
    .await
    .expect("slot request deadline")
    .unwrap();
    assert_eq!(
        server.requests.lock().unwrap()[0]["model"],
        "economy-wire-model"
    );
    let execution = result.assistant_message.metadata.model_execution.unwrap();
    assert_eq!(execution.model_config_id, "economy");
    assert_eq!(execution.effective_model_name, "economy-wire-model");
    assert_eq!(primary_source.completed.load(Ordering::SeqCst), 0);
    assert_eq!(economy_source.completed.load(Ordering::SeqCst), 1);
    assert_eq!(
        economy_source.resolved.load(Ordering::SeqCst),
        0,
        "reuse the exact prepared account instead of selecting it again"
    );
}

#[tokio::test]
async fn smart_slot_switches_sources_and_consumes_each_initial_account_once() {
    let server = RetryTestServer::new(vec![retry_test_success()]);
    let (mut primary, primary_source) = slot(&server, "primary");
    let (mut economy, economy_source) = slot(&server, "economy");
    let executor = test_round_executor();
    for (round, expected) in ["primary", "economy", "economy", "primary"]
        .into_iter()
        .enumerate()
    {
        let selected = if expected == "primary" {
            &mut primary
        } else {
            &mut economy
        };
        let mut request = selected.take_for_round();
        let mut context = context();
        context.round_number = round;
        let client = request.install(&mut context);
        assert_eq!(context.prepared_model.is_some(), round < 2);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            executor.execute_round(
                client,
                context,
                vec![AIMessage::user("Continue synthetic history".into())],
                None,
                None,
            ),
        )
        .await
        .expect("slot request deadline")
        .unwrap();
        assert_eq!(
            result
                .assistant_message
                .metadata
                .model_execution
                .unwrap()
                .model_config_id,
            expected
        );
    }
    let models: Vec<_> = server
        .requests
        .lock()
        .unwrap()
        .iter()
        .map(|body| body["model"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        models,
        [
            "primary-wire-model",
            "economy-wire-model",
            "economy-wire-model",
            "primary-wire-model"
        ]
    );
    for source in [primary_source, economy_source] {
        assert_eq!(source.completed.load(Ordering::SeqCst), 2);
        assert_eq!(
            source.resolved.load(Ordering::SeqCst),
            1,
            "later rounds must use this slot's live account policy"
        );
    }
}

#[tokio::test]
async fn smart_slot_overflow_reentry_keeps_the_economy_source_and_attempt_lifecycle() {
    let server = RetryTestServer::new(vec![
        (400, serde_json::json!({"error": {"code": "context_length_exceeded", "message": "context length exceeded"}}).to_string()),
        retry_test_success(),
    ]);
    let (mut economy, source) = slot(&server, "economy");
    let mut selected = economy.take_for_round();
    let executor = test_round_executor();
    let mut lifecycle = ModelRoundLifecycle::new();
    for attempt in 0..2 {
        let mut context = context();
        let client = selected.install(&mut context);
        assert_eq!(context.prepared_model.is_some(), attempt == 0);
        let result = tokio::time::timeout(
            Duration::from_secs(5),
            executor.execute_round_with_lifecycle(
                client,
                context,
                vec![AIMessage::user("Smaller synthetic history".into())],
                None,
                None,
                &mut lifecycle,
                None,
                None,
            ),
        )
        .await
        .expect("slot request deadline");
        if attempt == 0 {
            assert!(matches!(
                result,
                Err(crate::util::errors::OpenBitFunError::RecoverableContextOverflow(_))
            ));
        } else {
            assert_eq!(
                result
                    .unwrap()
                    .assistant_message
                    .metadata
                    .model_execution
                    .unwrap()
                    .model_config_id,
                "economy"
            );
        }
    }
    assert_eq!(lifecycle.attempts_started(), 2);
    assert_eq!(source.resolved.load(Ordering::SeqCst), 1);
    assert_eq!(source.completed.load(Ordering::SeqCst), 1);
    assert!(server
        .requests
        .lock()
        .unwrap()
        .iter()
        .all(|body| body["model"] == "economy-wire-model"));
}

#[tokio::test]
async fn smart_slot_channel_switch_uses_its_own_route_and_preserves_durable_history() {
    use crate::infrastructure::ai::client_factory::AIClientFactory;
    use crate::service::config::types::{model_runtime_binding_fingerprint, AIModelConfig};
    use crate::service::config::{ConfigManagerSettings, ConfigService};
    use openbitfun_config_contracts::channel_routing::ModelChannelRouting;

    let server = RetryTestServer::new(vec![retry_test_success()]);
    let dir = tempfile::tempdir().unwrap();
    let service = Arc::new(
        ConfigService::with_settings(ConfigManagerSettings {
            path_manager: Some(Arc::new(
                crate::infrastructure::PathManager::with_user_root_for_tests(
                    dir.path().join("host"),
                ),
            )),
            auto_save: true,
            backup_count: 0,
        })
        .await
        .unwrap(),
    );
    let model = |id: &str, backup: Option<&str>| AIModelConfig {
        id: id.into(),
        name: id.into(),
        provider: "openai".into(),
        model_name: format!("{id}-wire-model"),
        base_url: server.client().config.base_url.clone(),
        request_url: Some(server.client().config.request_url.clone()),
        api_key: format!("synthetic-{id}-key"),
        enabled: true,
        channel_routing: backup.map(|backup| ModelChannelRouting {
            fallback_model_ids: vec![backup.into()],
            ..Default::default()
        }),
        ..Default::default()
    };
    service
        .set_config(
            "ai.models",
            vec![
                model("primary", Some("primary-backup")),
                model("primary-backup", None),
                model("economy", Some("economy-backup")),
                model("economy-backup", None),
            ],
        )
        .await
        .unwrap();
    let models = service.get_effective_ai_config().await.unwrap().models;
    let factory = Arc::new(AIClientFactory::new_for_test(service));
    let prepare = |id: &'static str| {
        let model = models.iter().find(|model| model.id == id).unwrap();
        let fingerprint = model_runtime_binding_fingerprint(model);
        let factory = factory.clone();
        async move {
            let (prepared, channels) = factory
                .prepare_native_routed_model_client(
                    id,
                    &fingerprint,
                    None,
                    Some("smart-slot-lineage"),
                    None,
                )
                .await
                .unwrap();
            RoundExecutionClient::new(id.into(), prepared, channels)
        }
    };
    let mut primary = prepare("primary").await;
    let mut economy = prepare("economy").await;
    let mut context = context();
    primary.take_for_round().install(&mut context);
    let client = economy.take_for_round().install(&mut context);
    assert!(Arc::ptr_eq(
        context.channel_client_source.as_ref().unwrap(),
        economy.channel_source.as_ref().unwrap()
    ));
    let mut prior = AIMessage::assistant("Confirmed earlier work".into());
    prior.thinking_signature = Some("private-primary-signature".into());
    prior.reasoning_content = Some("Private primary reasoning".into());
    prior.model_response_replay = Some(openbitfun_core_types::ModelResponseReplay {
        protocol: "openai".into(),
        channel_origin: Some("primary".into()),
        channel_fingerprint: Some(primary.ai_client.channel_replay_fingerprint()),
        account_origin: None,
        items: vec![],
    });
    let history = vec![
        AIMessage::user("Continue the confirmed earlier work".into()),
        prior,
    ];
    let before = serde_json::to_value(&history).unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(5),
        test_round_executor().execute_round(client, context, history.clone(), None, None),
    )
    .await
    .expect("channel request deadline")
    .unwrap();
    assert_eq!(serde_json::to_value(&history).unwrap(), before);
    assert_eq!(
        result
            .assistant_message
            .metadata
            .model_execution
            .unwrap()
            .model_config_id,
        "economy"
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["model"], "economy-wire-model");
    let body = requests[0].to_string();
    assert!(body.contains("Confirmed earlier work"));
    assert!(!body.contains("private-primary-signature"));
    assert!(!body.contains("Private primary reasoning"));
}
