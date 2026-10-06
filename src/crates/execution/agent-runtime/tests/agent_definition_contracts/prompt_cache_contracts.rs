use openbitfun_agent_runtime::prompt_cache::{
    prompt_cache_persist_action, prompt_cache_scope_key, reconcile_prompt_cache_restore,
    CachedPromptText, CachedSystemPrompt, CachedUserContext, PromptCacheLookup,
    PromptCachePersistenceWriteAction, PromptCachePolicy, PromptCacheRestoreDecision,
    PromptCacheScope, SessionPromptCache, SessionPromptCacheStore, SystemPromptCacheIdentity,
    UserContextCacheIdentity, DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL,
};
use std::time::Duration;

#[test]
fn prompt_cache_policy_keeps_existing_default_persistence_ttl() {
    let policy = PromptCachePolicy::default();

    assert_eq!(policy.cache_ttl, None);
    assert_eq!(
        policy.persistence_ttl,
        Some(DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL)
    );
}

#[test]
fn prompt_cache_lookup_preserves_identity_and_expiry_semantics() {
    let store = SessionPromptCacheStore::new();
    store.create_session("session-1");
    store.set_system_prompt(
        "session-1",
        CachedSystemPrompt::new(
            SystemPromptCacheIdentity::new("template:standard_mode"),
            "system prompt",
        ),
    );
    store.set_user_context(
        "session-1",
        CachedUserContext::new(
            UserContextCacheIdentity::new("workspace_context"),
            "user context",
        ),
    );

    assert!(matches!(
        store.lookup_system_prompt(
            "session-1",
            &SystemPromptCacheIdentity::new("template:plan_mode"),
            None
        ),
        PromptCacheLookup::Miss
    ));
    assert!(matches!(
        store.lookup_user_context(
            "session-1",
            &UserContextCacheIdentity::new("workspace_context"),
            Some(Duration::from_millis(0))
        ),
        PromptCacheLookup::Expired
    ));
    assert!(store
        .get_cache("session-1")
        .expect("session cache")
        .user_context
        .is_none());

    assert!(store.invalidate("session-1", PromptCacheScope::All));
    let cache = store.get_cache("session-1").expect("session cache");
    assert!(cache.system_prompt.is_none());
    assert!(cache.user_context.is_none());
}

#[test]
fn prompt_cache_scope_key_preserves_legacy_mode_switch_shape() {
    assert_eq!(
        prompt_cache_scope_key(
            &SystemPromptCacheIdentity::new("template:standard_mode"),
            &UserContextCacheIdentity::new("workspace_context|workspace_instructions"),
        ),
        "template:standard_mode||workspace_context|workspace_instructions"
    );
}

#[test]
fn prompt_cache_restore_decision_prunes_expired_persisted_entries() {
    let mut restored = SessionPromptCache {
        system_prompt: Some(CachedSystemPrompt {
            text: CachedPromptText {
                content: "stale prompt".to_string(),
                created_at_ms: 0,
            },
            identity: SystemPromptCacheIdentity::new("template:standard_mode"),
        }),
        ..Default::default()
    };
    restored.user_context = Some(CachedUserContext::new(
        UserContextCacheIdentity::new("workspace_context"),
        "fresh context",
    ));

    let decision =
        reconcile_prompt_cache_restore(restored, Some(Duration::from_secs(60 * 60 * 24 * 365)));

    let cache = match decision {
        PromptCacheRestoreDecision::SavePruned(cache) => cache,
        other => panic!("expected pruned cache to be saved, got {other:?}"),
    };
    assert!(cache.system_prompt.is_none());
    assert_eq!(
        cache.user_context.expect("fresh user context").text.content,
        "fresh context"
    );
}

#[test]
fn prompt_cache_restore_decision_deletes_empty_expired_cache() {
    let restored = SessionPromptCache {
        system_prompt: Some(CachedSystemPrompt {
            text: CachedPromptText {
                content: "stale prompt".to_string(),
                created_at_ms: 0,
            },
            identity: SystemPromptCacheIdentity::new("template:standard_mode"),
        }),
        ..Default::default()
    };

    let decision =
        reconcile_prompt_cache_restore(restored, Some(Duration::from_secs(60 * 60 * 24 * 365)));

    assert_eq!(decision, PromptCacheRestoreDecision::DeleteExpired);
}

#[test]
fn prompt_cache_persist_action_deletes_empty_cache_and_saves_non_empty_cache() {
    assert_eq!(
        prompt_cache_persist_action(&SessionPromptCache::default()),
        PromptCachePersistenceWriteAction::Delete
    );

    let cache = SessionPromptCache {
        user_context: Some(CachedUserContext::new(
            UserContextCacheIdentity::new("workspace_context"),
            "context",
        )),
        ..Default::default()
    };
    assert_eq!(
        prompt_cache_persist_action(&cache),
        PromptCachePersistenceWriteAction::Save
    );
}
