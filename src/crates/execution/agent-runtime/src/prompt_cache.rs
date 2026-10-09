use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub const PROMPT_CACHE_SCHEMA_VERSION: u32 = 1;
pub const DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL: Duration = Duration::from_secs(60 * 60 * 24);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptCachePolicy {
    pub cache_ttl: Option<Duration>,
    pub persistence_ttl: Option<Duration>,
}

impl Default for PromptCachePolicy {
    fn default() -> Self {
        Self {
            cache_ttl: None,
            persistence_ttl: Some(DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SystemPromptCacheIdentity {
    pub scope_key: String,
}

impl SystemPromptCacheIdentity {
    pub fn new(scope_key: impl Into<String>) -> Self {
        Self {
            scope_key: scope_key.into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserContextCacheIdentity {
    pub scope_key: String,
}

impl UserContextCacheIdentity {
    pub fn new(scope_key: impl Into<String>) -> Self {
        Self {
            scope_key: scope_key.into(),
        }
    }
}

pub fn prompt_cache_scope_key(
    system_prompt: &SystemPromptCacheIdentity,
    user_context: &UserContextCacheIdentity,
) -> String {
    format!("{}||{}", system_prompt.scope_key, user_context.scope_key)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedPromptText {
    pub content: String,
    pub created_at_ms: u64,
}

impl CachedPromptText {
    pub fn new(content: impl Into<String>) -> Self {
        Self {
            content: content.into(),
            created_at_ms: current_time_ms(),
        }
    }

    pub fn is_expired(&self, ttl: Option<Duration>, now_ms: u64) -> bool {
        ttl.is_some_and(|ttl| {
            let ttl_ms = ttl.as_millis().try_into().unwrap_or(u64::MAX);
            now_ms.saturating_sub(self.created_at_ms) >= ttl_ms
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedSystemPrompt {
    #[serde(flatten)]
    pub text: CachedPromptText,
    pub identity: SystemPromptCacheIdentity,
}

impl CachedSystemPrompt {
    pub fn new(identity: SystemPromptCacheIdentity, content: impl Into<String>) -> Self {
        Self {
            text: CachedPromptText::new(content),
            identity,
        }
    }

    pub fn is_usable(
        &self,
        identity: &SystemPromptCacheIdentity,
        ttl: Option<Duration>,
        now_ms: u64,
    ) -> bool {
        self.identity == *identity && !self.text.is_expired(ttl, now_ms)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CachedUserContext {
    #[serde(flatten)]
    pub text: CachedPromptText,
    pub identity: UserContextCacheIdentity,
}

impl CachedUserContext {
    pub fn new(identity: UserContextCacheIdentity, content: impl Into<String>) -> Self {
        Self {
            text: CachedPromptText::new(content),
            identity,
        }
    }

    pub fn is_usable(
        &self,
        identity: &UserContextCacheIdentity,
        ttl: Option<Duration>,
        now_ms: u64,
    ) -> bool {
        self.identity == *identity && !self.text.is_expired(ttl, now_ms)
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPromptCache {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<CachedSystemPrompt>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_context: Option<CachedUserContext>,
}

impl SessionPromptCache {
    pub fn apply_persistence_ttl(&mut self, ttl: Option<Duration>) -> bool {
        let now_ms = current_time_ms();
        let mut changed = false;

        if self
            .system_prompt
            .as_ref()
            .is_some_and(|entry| entry.text.is_expired(ttl, now_ms))
        {
            self.system_prompt = None;
            changed = true;
        }

        if self
            .user_context
            .as_ref()
            .is_some_and(|entry| entry.text.is_expired(ttl, now_ms))
        {
            self.user_context = None;
            changed = true;
        }

        changed
    }

    pub fn is_empty(&self) -> bool {
        self.system_prompt.is_none() && self.user_context.is_none()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCachePersistenceWriteAction {
    Save,
    Delete,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptCacheRestoreDecision {
    Keep(SessionPromptCache),
    SavePruned(SessionPromptCache),
    DeleteExpired,
}

impl PromptCacheRestoreDecision {
    pub fn into_cache(self) -> Option<SessionPromptCache> {
        match self {
            Self::Keep(cache) | Self::SavePruned(cache) => Some(cache),
            Self::DeleteExpired => None,
        }
    }
}

pub fn reconcile_prompt_cache_restore(
    mut cache: SessionPromptCache,
    persistence_ttl: Option<Duration>,
) -> PromptCacheRestoreDecision {
    if !cache.apply_persistence_ttl(persistence_ttl) {
        return PromptCacheRestoreDecision::Keep(cache);
    }

    if cache.is_empty() {
        PromptCacheRestoreDecision::DeleteExpired
    } else {
        PromptCacheRestoreDecision::SavePruned(cache)
    }
}

pub fn prompt_cache_persist_action(
    cache: &SessionPromptCache,
) -> PromptCachePersistenceWriteAction {
    if cache.is_empty() {
        PromptCachePersistenceWriteAction::Delete
    } else {
        PromptCachePersistenceWriteAction::Save
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PromptCacheScope {
    SystemPrompt,
    UserContext,
    All,
}

impl PromptCacheScope {
    fn clears_system_prompt(self) -> bool {
        matches!(self, Self::SystemPrompt | Self::All)
    }

    fn clears_user_context(self) -> bool {
        matches!(self, Self::UserContext | Self::All)
    }
}

pub struct SessionPromptCacheStore {
    session_caches: Arc<DashMap<String, SessionPromptCache>>,
    user_context_generations: Arc<DashMap<String, u64>>,
}

pub enum PromptCacheLookup {
    Hit(String),
    Miss,
    Expired,
}

impl Default for SessionPromptCacheStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionPromptCacheStore {
    pub fn new() -> Self {
        Self {
            session_caches: Arc::new(DashMap::new()),
            user_context_generations: Arc::new(DashMap::new()),
        }
    }

    pub fn create_session(&self, session_id: &str) {
        self.user_context_generations
            .entry(session_id.to_string())
            .or_insert(0);
        self.session_caches
            .entry(session_id.to_string())
            .or_default();
    }

    pub fn has_session(&self, session_id: &str) -> bool {
        self.session_caches.contains_key(session_id)
    }

    pub fn replace_cache(&self, session_id: &str, cache: SessionPromptCache) {
        self.user_context_generations
            .entry(session_id.to_string())
            .or_insert(0);
        self.session_caches.insert(session_id.to_string(), cache);
    }

    pub fn get_cache(&self, session_id: &str) -> Option<SessionPromptCache> {
        self.session_caches
            .get(session_id)
            .map(|cache| cache.clone())
    }

    pub fn lookup_system_prompt(
        &self,
        session_id: &str,
        identity: &SystemPromptCacheIdentity,
        ttl: Option<Duration>,
    ) -> PromptCacheLookup {
        let now_ms = current_time_ms();
        let Some(cache) = self.session_caches.get(session_id) else {
            return PromptCacheLookup::Miss;
        };
        let Some(entry) = cache.system_prompt.as_ref() else {
            return PromptCacheLookup::Miss;
        };

        if entry.is_usable(identity, ttl, now_ms) {
            return PromptCacheLookup::Hit(entry.text.content.clone());
        }

        if entry.text.is_expired(ttl, now_ms) {
            drop(cache);
            self.invalidate(session_id, PromptCacheScope::SystemPrompt);
            return PromptCacheLookup::Expired;
        }

        PromptCacheLookup::Miss
    }

    pub fn lookup_user_context(
        &self,
        session_id: &str,
        identity: &UserContextCacheIdentity,
        ttl: Option<Duration>,
    ) -> PromptCacheLookup {
        let now_ms = current_time_ms();
        let Some(cache) = self.session_caches.get(session_id) else {
            return PromptCacheLookup::Miss;
        };
        let Some(entry) = cache.user_context.as_ref() else {
            return PromptCacheLookup::Miss;
        };

        if entry.is_usable(identity, ttl, now_ms) {
            return PromptCacheLookup::Hit(entry.text.content.clone());
        }

        if entry.text.is_expired(ttl, now_ms) {
            drop(cache);
            self.invalidate(session_id, PromptCacheScope::UserContext);
            return PromptCacheLookup::Expired;
        }

        PromptCacheLookup::Miss
    }

    pub fn set_system_prompt(&self, session_id: &str, entry: CachedSystemPrompt) {
        if let Some(mut cache) = self.session_caches.get_mut(session_id) {
            cache.system_prompt = Some(entry);
        } else {
            self.session_caches.insert(
                session_id.to_string(),
                SessionPromptCache {
                    system_prompt: Some(entry),
                    user_context: None,
                },
            );
        }
    }

    pub fn set_user_context(&self, session_id: &str, entry: CachedUserContext) {
        if let Some(mut cache) = self.session_caches.get_mut(session_id) {
            cache.user_context = Some(entry);
        } else {
            self.session_caches.insert(
                session_id.to_string(),
                SessionPromptCache {
                    system_prompt: None,
                    user_context: Some(entry),
                },
            );
        }
    }

    pub fn user_context_generation(&self, session_id: &str) -> u64 {
        *self
            .user_context_generations
            .entry(session_id.to_string())
            .or_insert(0)
    }

    pub fn set_user_context_if_generation(
        &self,
        session_id: &str,
        expected_generation: u64,
        entry: CachedUserContext,
    ) -> bool {
        let generation = self
            .user_context_generations
            .entry(session_id.to_string())
            .or_insert(0);
        if *generation != expected_generation {
            return false;
        }
        self.set_user_context(session_id, entry);
        true
    }

    pub fn invalidate(&self, session_id: &str, scope: PromptCacheScope) -> bool {
        let _user_context_generation = if scope.clears_user_context() {
            let mut generation = self
                .user_context_generations
                .entry(session_id.to_string())
                .or_insert(0);
            *generation = generation.saturating_add(1);
            Some(generation)
        } else {
            None
        };
        let Some(mut cache) = self.session_caches.get_mut(session_id) else {
            return false;
        };

        let mut changed = false;
        if scope.clears_system_prompt() && cache.system_prompt.take().is_some() {
            changed = true;
        }
        if scope.clears_user_context() && cache.user_context.take().is_some() {
            changed = true;
        }
        changed
    }

    pub fn delete_session(&self, session_id: &str) {
        self.user_context_generations.remove(session_id);
        self.session_caches.remove(session_id);
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::{
        CachedSystemPrompt, CachedUserContext, PromptCacheLookup, PromptCachePolicy,
        PromptCacheScope, SessionPromptCacheStore, SystemPromptCacheIdentity,
        UserContextCacheIdentity, DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL,
    };
    use std::time::Duration;

    #[test]
    fn default_prompt_cache_policy_uses_one_day_persistence_ttl() {
        let policy = PromptCachePolicy::default();

        assert_eq!(policy.cache_ttl, None);
        assert_eq!(
            policy.persistence_ttl,
            Some(DEFAULT_PROMPT_CACHE_PERSISTENCE_TTL)
        );
    }

    #[test]
    fn system_prompt_cache_requires_matching_identity() {
        let store = SessionPromptCacheStore::new();
        store.create_session("session-1");
        store.set_system_prompt(
            "session-1",
            CachedSystemPrompt::new(
                SystemPromptCacheIdentity::new("template:standard_mode"),
                "prompt-a",
            ),
        );

        assert_eq!(
            match store.lookup_system_prompt(
                "session-1",
                &SystemPromptCacheIdentity::new("template:standard_mode"),
                None,
            ) {
                PromptCacheLookup::Hit(value) => Some(value),
                _ => None,
            },
            Some("prompt-a".to_string())
        );
        assert!(matches!(
            store.lookup_system_prompt(
                "session-1",
                &SystemPromptCacheIdentity::new("template:cowork_mode"),
                None,
            ),
            PromptCacheLookup::Miss
        ));
    }

    #[test]
    fn expired_user_context_is_evicted_on_read() {
        let store = SessionPromptCacheStore::new();
        store.create_session("session-1");
        store.set_user_context(
            "session-1",
            CachedUserContext::new(
                UserContextCacheIdentity::new("workspace_context|workspace_instructions"),
                "stale context",
            ),
        );

        assert!(matches!(
            store.lookup_user_context(
                "session-1",
                &UserContextCacheIdentity::new("workspace_context|workspace_instructions"),
                Some(Duration::from_millis(0)),
            ),
            PromptCacheLookup::Expired
        ));
        assert!(store
            .get_cache("session-1")
            .expect("session cache")
            .user_context
            .is_none());
    }

    #[test]
    fn invalidate_scope_can_clear_all_cached_prompt_parts() {
        let store = SessionPromptCacheStore::new();
        store.create_session("session-1");
        store.set_system_prompt(
            "session-1",
            CachedSystemPrompt::new(
                SystemPromptCacheIdentity::new("template:standard_mode"),
                "prompt-a",
            ),
        );
        store.set_user_context(
            "session-1",
            CachedUserContext::new(
                UserContextCacheIdentity::new("workspace_context"),
                "context",
            ),
        );

        assert!(store.invalidate("session-1", PromptCacheScope::All));

        let cache = store.get_cache("session-1").expect("session cache");
        assert!(cache.system_prompt.is_none());
        assert!(cache.user_context.is_none());
    }

    #[test]
    fn invalidation_rejects_a_stale_user_context_write_even_when_cache_is_empty() {
        let store = SessionPromptCacheStore::new();
        store.create_session("session-1");
        let generation = store.user_context_generation("session-1");

        assert!(!store.invalidate("session-1", PromptCacheScope::UserContext));
        assert!(!store.set_user_context_if_generation(
            "session-1",
            generation,
            CachedUserContext::new(UserContextCacheIdentity::new("workspace_context"), "stale"),
        ));
        assert!(store
            .get_cache("session-1")
            .expect("session cache")
            .user_context
            .is_none());
    }
}
