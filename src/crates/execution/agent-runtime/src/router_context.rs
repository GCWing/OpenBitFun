//! Router-only, incremental context. Never contains or mutates agent compression state.

mod token_budget;
pub use token_budget::{EstimatedRouterTokens, RouterInputBudget};
mod history_batch;
pub use history_batch::RouterHistoryBatch;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const OBSERVATION_BUFFER_CAPACITY: usize = 128;

/// Admission budget for the final Router summary text, separate from the
/// provider's combined reasoning/output allowance. Counts are a conservative
/// local estimate, not model tokenizer counts or billing usage. This policy
/// never truncates text or changes persisted history.
#[derive(Debug, Clone, Copy)]
pub struct RouterSummaryBudget {
    max_tokens: usize,
}

impl RouterSummaryBudget {
    /// A zero budget cannot admit a nonempty summary.
    pub fn new(max_tokens: usize) -> Option<Self> {
        (max_tokens > 0).then_some(Self { max_tokens })
    }

    pub fn max_tokens(&self) -> usize {
        self.max_tokens
    }

    /// Leave headroom between the requested length and the admission ceiling
    /// because providers cannot count this host-side heuristic exactly.
    pub fn target_tokens(&self) -> usize {
        self.max_tokens
            .saturating_sub(self.max_tokens.div_ceil(4))
            .max(1)
    }

    pub fn estimate(&self, text: &str) -> usize {
        EstimatedRouterTokens.count(text.trim())
    }

    pub fn accepts(&self, text: &str) -> bool {
        !text.trim().is_empty() && self.estimate(text) <= self.max_tokens
    }
}

pub trait RouterTokenCounter: Send + Sync {
    fn count(&self, text: &str) -> usize;
    fn name(&self) -> &'static str;
    fn cacheable(&self) -> bool {
        true
    }
    fn cached_projection(&self, _text: &str, _budget: usize) -> Option<Value> {
        None
    }
    fn remember_projection(&self, _text: &str, _budget: usize, _value: &Value) {}
    fn metrics(&self) -> RouterTokenMetrics {
        RouterTokenMetrics::default()
    }
}

#[derive(Debug, Default, Clone, Copy, Serialize)]
pub struct RouterTokenMetrics {
    pub cache_hits: u64,
    pub encode_calls: u64,
    pub encoded_bytes: u64,
    pub encode_us: u64,
    pub projection_hits: u64,
}

impl RouterTokenMetrics {
    pub fn since(self, before: Self) -> Self {
        Self {
            cache_hits: self.cache_hits.saturating_sub(before.cache_hits),
            encode_calls: self.encode_calls.saturating_sub(before.encode_calls),
            encoded_bytes: self.encoded_bytes.saturating_sub(before.encoded_bytes),
            encode_us: self.encode_us.saturating_sub(before.encode_us),
            projection_hits: self.projection_hits.saturating_sub(before.projection_hits),
        }
    }
}

/// Exact, FIFO-bounded memoization. Keys retain full bytes, so hash collisions cannot
/// change a token count or projection. The two caches are owned by one Router turn,
/// never serialized, and never hold a lock while calling the tokenizer.
pub struct CachedRouterTokenCounter {
    inner: Arc<dyn RouterTokenCounter>,
    tokens: Mutex<RouterMemo<usize>>,
    projections: Mutex<RouterMemo<Value>>,
    hits: AtomicU64,
    calls: AtomicU64,
    bytes: AtomicU64,
    encode_us: AtomicU64,
    projection_hits: AtomicU64,
}

struct RouterMemo<T> {
    values: HashMap<usize, HashMap<Arc<str>, T>>,
    order: VecDeque<(Arc<str>, usize, usize)>,
    bytes: usize,
    entries: usize,
    max_bytes: usize,
    max_entries: usize,
}

impl<T> RouterMemo<T> {
    fn new(max_bytes: usize, max_entries: usize) -> Self {
        Self {
            values: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            entries: 0,
            max_bytes,
            max_entries,
        }
    }

    fn get(&self, text: &str, budget: usize) -> Option<&T> {
        self.values.get(&budget)?.get(text)
    }

    fn insert(&mut self, key: (Arc<str>, usize), value: T, cost: usize) {
        // Include a conservative allowance for map/queue nodes as well as payload bytes.
        let cost = cost.saturating_add(256);
        if cost > self.max_bytes || self.max_entries == 0 || self.get(&key.0, key.1).is_some() {
            return;
        }
        while self.bytes.saturating_add(cost) > self.max_bytes || self.entries >= self.max_entries {
            let Some((text, budget, bytes)) = self.order.pop_front() else {
                break;
            };
            if let Some(values) = self.values.get_mut(&budget) {
                values.remove(&text);
                if values.is_empty() {
                    self.values.remove(&budget);
                }
            }
            self.bytes -= bytes;
            self.entries -= 1;
        }
        self.order.push_back((key.0.clone(), key.1, cost));
        self.values.entry(key.1).or_default().insert(key.0, value);
        self.bytes += cost;
        self.entries += 1;
    }
}

impl CachedRouterTokenCounter {
    pub fn new(inner: Arc<dyn RouterTokenCounter>) -> Self {
        Self::with_limits(inner, 4 * 1024 * 1024, 4096)
    }

    fn with_limits(inner: Arc<dyn RouterTokenCounter>, bytes: usize, entries: usize) -> Self {
        Self {
            inner,
            tokens: Mutex::new(RouterMemo::new(bytes, entries)),
            projections: Mutex::new(RouterMemo::new(bytes, entries.min(256))),
            hits: AtomicU64::new(0),
            calls: AtomicU64::new(0),
            bytes: AtomicU64::new(0),
            encode_us: AtomicU64::new(0),
            projection_hits: AtomicU64::new(0),
        }
    }
}

impl RouterTokenCounter for CachedRouterTokenCounter {
    fn count(&self, text: &str) -> usize {
        let cacheable = text.len() <= 65_536 && self.inner.cacheable();
        if cacheable {
            if let Some(value) = self
                .tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(text, 0)
                .copied()
            {
                self.hits.fetch_add(1, Ordering::Relaxed);
                return value;
            }
        }
        let started = Instant::now();
        let count = self.inner.count(text);
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(text.len() as u64, Ordering::Relaxed);
        self.encode_us
            .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
        if cacheable && self.inner.cacheable() {
            self.tokens
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert((Arc::from(text), 0), count, text.len());
        }
        count
    }

    fn name(&self) -> &'static str {
        self.inner.name()
    }
    fn cacheable(&self) -> bool {
        self.inner.cacheable()
    }

    fn cached_projection(&self, text: &str, budget: usize) -> Option<Value> {
        if text.len() > 65_536 || !self.inner.cacheable() {
            return None;
        }
        let result = self
            .projections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(text, budget)
            .cloned();
        if result.is_some() {
            self.projection_hits.fetch_add(1, Ordering::Relaxed);
        }
        result
    }

    fn remember_projection(&self, text: &str, budget: usize, value: &Value) {
        if text.len() > 65_536 || !self.inner.cacheable() {
            return;
        }
        // Charge container nodes too: a large array of nulls has little JSON text
        // but substantially more heap usage. This is accounting, not an allocator limit.
        fn value_cost(value: &Value) -> usize {
            std::mem::size_of::<Value>().saturating_add(match value {
                Value::String(text) => text.capacity(),
                Value::Array(values) => values.iter().fold(0usize, |bytes, value| {
                    bytes.saturating_add(value_cost(value)).saturating_add(32)
                }),
                Value::Object(values) => values.iter().fold(0usize, |bytes, (key, value)| {
                    bytes
                        .saturating_add(key.capacity())
                        .saturating_add(value_cost(value))
                        .saturating_add(128)
                }),
                _ => 0,
            })
        }
        let cost = text.len().saturating_add(value_cost(value));
        self.projections
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert((Arc::<str>::from(text), budget), value.clone(), cost);
    }

    fn metrics(&self) -> RouterTokenMetrics {
        RouterTokenMetrics {
            cache_hits: self.hits.load(Ordering::Relaxed),
            encode_calls: self.calls.load(Ordering::Relaxed),
            encoded_bytes: self.bytes.load(Ordering::Relaxed),
            encode_us: self.encode_us.load(Ordering::Relaxed),
            projection_hits: self.projection_hits.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Default, Clone, Serialize)]
pub struct RouterPreparationMetrics {
    pub generation_lookup_ms: u64,
    pub generation_observe_ms: u64,
    pub observe_ms: u64,
    pub summary_apply_ms: u64,
    pub summary_prepare_ms: u64,
    pub checkpoint_ms: u64,
    pub render_ms: u64,
    pub tokens: RouterTokenMetrics,
}

/// Conservative fallback for the router's byte-level BPE when no tokenizer is installed.
pub struct Utf8ByteBudget;

impl RouterTokenCounter for Utf8ByteBudget {
    fn count(&self, text: &str) -> usize {
        text.len()
    }

    fn name(&self) -> &'static str {
        "utf8_byte_upper_bound"
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouterEntryKind {
    Round,
    UserUpdate,
    Feedback,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouterEntry {
    pub sequence: u64,
    pub source_id: String,
    pub kind: RouterEntryKind,
    #[serde(default)]
    pub is_error: bool,
    /// Exact Router-tokenizer count of the projected content serialized as JSON.
    #[serde(default)]
    pub token_count: usize,
    pub content: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RouterContextState {
    pub version: u32,
    pub session_id: String,
    pub dialog_turn_id: String,
    pub task: String,
    pub summary: String,
    pub summarized_through: u64,
    pub next_sequence: u64,
    pub observed_rounds: u64,
    /// Highest observation dropped without coverage from an accepted summary.
    pub omitted_through: u64,
    pub entries: VecDeque<RouterEntry>,
    pub seen_message_ids: HashSet<String>,
    pub latest_user_updates: VecDeque<String>,
    /// Source progress for a host-owned history rebuild. Even a finished worker
    /// remains ineligible until the host merges observations made while it ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history_bootstrap: Option<RouterHistoryBootstrap>,
    /// Ordered visible turns whose complete observations have been verified by
    /// the host. Legacy sidecars without this proof require a history rebuild.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub history_coverage: Vec<String>,
}

/// Portable recovery cursor; the execution host owns source IO and generation fencing.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RouterHistoryBootstrap {
    pub turn_ids: Vec<String>,
    pub turn_cursor: usize,
    pub entry_cursor: usize,
    pub complete: bool,
}

impl Default for RouterContextState {
    fn default() -> Self {
        Self {
            version: 1,
            session_id: String::new(),
            dialog_turn_id: String::new(),
            task: String::new(),
            summary: String::new(),
            summarized_through: 0,
            next_sequence: 1,
            observed_rounds: 0,
            omitted_through: 0,
            entries: VecDeque::new(),
            seen_message_ids: HashSet::new(),
            latest_user_updates: VecDeque::new(),
            history_bootstrap: None,
            history_coverage: Vec::new(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct RouterSummaryWork {
    pub base_through: u64,
    pub through: u64,
    /// Missing history when this immutable summary input was captured. A later
    /// summary cannot recover observations that were already absent here.
    pub omitted_through: u64,
    pub pending_tokens: usize,
    pub prompt: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouterEntryTokenRecord {
    pub sequence: u64,
    pub source_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub round_id: Option<String>,
    pub kind: RouterEntryKind,
    pub section: &'static str,
    pub token_count: usize,
    pub is_error: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct RouterCompressionRecord {
    pub status: String,
    pub base_through: u64,
    pub through: u64,
    pub pending_tokens: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub usage: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PreparedRouterContext {
    /// Execution-local feedback channel; never persisted or exposed in traces.
    #[serde(skip)]
    pub token_budget: Option<Arc<RouterInputBudget>>,
    /// Trace writers emit the actual input separately from these budget/cursor facts.
    #[serde(skip_serializing)]
    pub user_prompt: String,
    pub preparation_ms: u64,
    pub preparation: RouterPreparationMetrics,
    pub input_tokens: usize,
    pub budget_tokens: usize,
    /// The complete retained history did not fit, dropped observations are not
    /// covered by an accepted summary, or a history rebuild awaits host merge.
    /// Bounded projections of individual logs remain normal Router input and do
    /// not set this fact.
    pub history_truncated: bool,
    pub pending_tokens: usize,
    pub entry_tokens: Vec<RouterEntryTokenRecord>,
    pub compression_records: Vec<RouterCompressionRecord>,
    pub counter: &'static str,
    pub summarized_through: u64,
    pub observed_through: u64,
    pub omitted_through: u64,
}

impl RouterContextState {
    /// Hosts importing durable history must summarize a prefix before appending
    /// another entry when this buffer is full.
    pub fn observation_buffer_full(&self) -> bool {
        self.entries.len() >= OBSERVATION_BUFFER_CAPACITY
    }

    pub fn claim_message(&mut self, id: &str) -> bool {
        !self.seen_message_ids.contains(id) && self.seen_message_ids.insert(id.to_string())
    }

    pub fn append(
        &mut self,
        source_id: String,
        kind: RouterEntryKind,
        content: Value,
        counter: &dyn RouterTokenCounter,
    ) {
        let entry = self.observation_entry(source_id, kind, content, counter);
        self.append_entry(entry, counter);
        // Backpressure for failed/slow summary providers, never an agent-loop limit.
        while self.entries.len() > OBSERVATION_BUFFER_CAPACITY {
            if let Some(entry) = self.entries.pop_front() {
                self.omitted_through = entry.sequence;
            }
        }
    }

    fn append_entry(&mut self, entry: RouterEntry, counter: &dyn RouterTokenCounter) {
        if entry.kind == RouterEntryKind::Round {
            self.observed_rounds += 1;
        }
        if entry.kind == RouterEntryKind::UserUpdate {
            if entry.content.as_str() == Some(self.task.as_str()) {
                // Initial history can include previous tasks. The current task resets
                // their steering priority without erasing historical observations.
                self.latest_user_updates.clear();
            }
            if let Some(text) = entry.content.as_str().filter(|text| *text != self.task) {
                if self.latest_user_updates.back().map(String::as_str) != Some(text) {
                    self.latest_user_updates
                        .push_back(truncate(text, 1_024, counter));
                    while self.latest_user_updates.len() > 4 {
                        self.latest_user_updates.pop_front();
                    }
                }
            }
        }
        self.entries.push_back(entry);
        self.next_sequence += 1;
    }

    fn observation_entry(
        &self,
        source_id: String,
        kind: RouterEntryKind,
        content: Value,
        counter: &dyn RouterTokenCounter,
    ) -> RouterEntry {
        let content = project_observation(content, counter);
        let flagged = |value: &Value| value.get("is_error").and_then(Value::as_bool) == Some(true);
        let is_error = flagged(&content)
            || content
                .get("tool_results")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(flagged))
            || content
                .pointer("/assistant/tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|values| values.iter().any(flagged));
        // Count the exact representation retained by the Router. Counting happens
        // after deterministic projection, so raw multi-megabyte tool output never
        // reaches the tokenizer and every observed entry is charged exactly once.
        let mut entry = RouterEntry {
            sequence: self.next_sequence,
            source_id,
            kind,
            is_error,
            token_count: 0,
            content,
        };
        entry.token_count = counter.count(&entry_for_prompt(&entry).to_string());
        entry
    }

    /// Populate per-entry token metadata added after v1 checkpoints were introduced.
    pub fn refresh_token_counts(&mut self, counter: &dyn RouterTokenCounter) {
        for entry in &mut self.entries {
            entry.token_count = counter.count(&entry_for_prompt(entry).to_string());
        }
    }

    fn recent_start(&self, recent_rounds: usize) -> usize {
        self.entries
            .iter()
            .enumerate()
            .rev()
            .filter(|(_, entry)| entry.kind == RouterEntryKind::Round)
            .nth(recent_rounds.max(1) - 1)
            .map(|(index, _)| index)
            .unwrap_or(0)
    }

    pub fn pending_tokens(&self, recent_rounds: usize) -> usize {
        self.entries
            .iter()
            .take(self.recent_start(recent_rounds))
            .map(|entry| entry.token_count)
            .sum()
    }

    pub fn summary_work(
        &self,
        recent_rounds: usize,
        trigger_tokens: usize,
    ) -> Option<RouterSummaryWork> {
        let prefix: Vec<_> = self
            .entries
            .iter()
            .take(self.recent_start(recent_rounds))
            .collect();
        let pending_tokens = self.pending_tokens(recent_rounds);
        if pending_tokens < trigger_tokens {
            return None;
        }
        self.summary_work_for_prefix(&prefix)
    }

    /// Select a complete, contiguous observation prefix within the auxiliary
    /// model's user-prompt budget. The host separately reserves system/output
    /// tokens. A zero recent-round count permits bootstrap to flush all entries.
    pub fn summary_work_bounded(
        &self,
        recent_rounds: usize,
        trigger_tokens: usize,
        max_prompt_tokens: usize,
        counter: &dyn RouterTokenCounter,
    ) -> Option<RouterSummaryWork> {
        let count = if recent_rounds == 0 {
            self.entries.len()
        } else {
            self.recent_start(recent_rounds)
        };
        let prefix: Vec<_> = self.entries.iter().take(count).collect();
        if prefix.iter().map(|entry| entry.token_count).sum::<usize>() < trigger_tokens {
            return None;
        }
        let first = self.summary_work_for_prefix(prefix.get(..1)?)?;
        if counter.count(&first.prompt) > max_prompt_tokens {
            return None;
        }
        let mut selected = first;
        for count in 2..=prefix.len() {
            let work = self.summary_work_for_prefix(&prefix[..count])?;
            if counter.count(&work.prompt) <= max_prompt_tokens {
                selected = work;
            }
        }
        Some(selected)
    }

    fn summary_work_for_prefix(&self, prefix: &[&RouterEntry]) -> Option<RouterSummaryWork> {
        let through = prefix.last()?.sequence;
        let entries: Vec<_> = prefix.iter().map(|entry| entry_for_prompt(entry)).collect();
        Some(RouterSummaryWork {
            base_through: self.summarized_through,
            through,
            omitted_through: self.omitted_through,
            pending_tokens: prefix.iter().map(|entry| entry.token_count).sum(),
            prompt: self.summary_prompt(through, &json!(entries).to_string()),
        })
    }

    fn summary_prompt(&self, through: u64, entries: &str) -> String {
        format!(
            "Task:\n{}\n\nPrevious router summary:\n{}\n\nObserved entries through sequence {through}:\n{entries}\n\nPreviously omitted through sequence: {}",
            self.task,
            self.summary,
            self.omitted_through,
        )
    }

    pub fn apply_summary(&mut self, work: &RouterSummaryWork, summary: &str) -> bool {
        if work.base_through != self.summarized_through
            || work.through <= self.summarized_through
            || work.through >= self.next_sequence
            || summary.trim().is_empty()
        {
            return false;
        }
        self.summary = summary.trim().to_string();
        self.summarized_through = work.through;
        self.entries.retain(|entry| entry.sequence > work.through);
        // A summary captured before backpressure can retain observations later
        // evicted from the buffer. A snapshot captured after a gap cannot fill it.
        if work.omitted_through == 0 && self.omitted_through <= work.through {
            self.omitted_through = 0;
        }
        true
    }

    pub fn prepare(
        &self,
        recent_rounds: usize,
        max_tokens: usize,
        counter: &dyn RouterTokenCounter,
    ) -> PreparedRouterContext {
        let max_tokens = max_tokens.max(512);
        // Latest steering first so shrinking never preferentially drops the active request.
        let updates = self
            .latest_user_updates
            .iter()
            .rev()
            .cloned()
            .collect::<Vec<_>>()
            .join("\nPrevious user update:\n");
        let task = if updates.is_empty() {
            self.task.clone()
        } else {
            format!("{}\nUser update:\n{}", self.task, updates)
        };
        let start = self.recent_start(recent_rounds);
        let pending: Vec<_> = self
            .entries
            .iter()
            .take(start)
            .map(entry_for_prompt)
            .collect();
        let pending_tokens = self
            .entries
            .iter()
            .take(start)
            .map(|entry| entry.token_count)
            .sum();
        let history = match (
            self.summary.is_empty(),
            pending.is_empty(),
            self.omitted_through,
        ) {
            (true, true, 0) => "(none)".to_string(),
            _ => format!(
                "{}{}{}",
                if self.summary.is_empty() {
                    ""
                } else {
                    self.summary.as_str()
                },
                if pending.is_empty() {
                    String::new()
                } else {
                    format!("\nUnsummarized earlier observations: {}", json!(pending))
                },
                if self.omitted_through == 0 {
                    String::new()
                } else {
                    format!(
                        "\nEarlier observations omitted through sequence: {}",
                        self.omitted_through
                    )
                },
            ),
        };
        let recent: Vec<_> = self.entries.iter().skip(start).collect();
        let full_recent: Vec<_> = recent.iter().map(|entry| entry_for_prompt(entry)).collect();
        let entry_tokens = self
            .entries
            .iter()
            .enumerate()
            .map(|(index, entry)| RouterEntryTokenRecord {
                sequence: entry.sequence,
                source_id: entry.source_id.clone(),
                round_id: entry
                    .content
                    .get("round_id")
                    .filter(|value| !value.is_null())
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| value.to_string())
                    }),
                kind: entry.kind,
                section: if index < start { "pending" } else { "recent" },
                token_count: entry.token_count,
                is_error: entry.is_error,
            })
            .collect::<Vec<_>>();
        let full_prompt = format!(
            "## Task\n{task}\n\n## Earlier history summary\n{history}\n\n## Recent trajectory\n{}",
            json!(full_recent)
        );
        if counter.count(&full_prompt) <= max_tokens {
            return PreparedRouterContext {
                token_budget: None,
                preparation_ms: 0,
                preparation: RouterPreparationMetrics::default(),
                input_tokens: counter.count(&full_prompt),
                budget_tokens: max_tokens,
                history_truncated: self.omitted_through != 0 || self.history_bootstrap.is_some(),
                pending_tokens,
                entry_tokens,
                compression_records: Vec::new(),
                counter: counter.name(),
                user_prompt: full_prompt,
                summarized_through: self.summarized_through,
                observed_through: self.next_sequence.saturating_sub(1),
                omitted_through: self.omitted_through,
            };
        }

        // Overflow is exceptional relative to the training distribution. Preserve
        // the same three-section protocol and latest trajectory, shrinking only
        // after the complete training-shaped prompt has been measured.
        let task_budget = (max_tokens / 5).max(128);
        let task = truncate(&task, task_budget, counter);
        let history_budget = (max_tokens / 5).max(128);
        let history = truncate(&history, history_budget, counter);
        let newest_round = recent
            .iter()
            .rposition(|entry| entry.kind == RouterEntryKind::Round)
            .unwrap_or(recent.len().saturating_sub(1));
        let mut recent_budget = max_tokens
            .saturating_sub(counter.count(&task) + counter.count(&history) + 100)
            .max(64);
        let user_prompt = loop {
            // The newest completed round gets half the detail; feedback retains its own share.
            let mut rendered = Vec::new();
            for (index, entry) in recent.iter().enumerate() {
                let budget = if recent.len() == 1 {
                    recent_budget
                } else if index == newest_round {
                    recent_budget / 2
                } else {
                    recent_budget / (2 * (recent.len() - 1))
                };
                // Sequence/ids are bookkeeping, not useful prediction input. Keep the original
                // trajectory shape for rounds and explicit wrappers only for feedback.
                let value = if entry.kind == RouterEntryKind::Round {
                    let mut value = entry.content.clone();
                    if let Some(object) = value.as_object_mut() {
                        object.insert("is_error".into(), json!(entry.is_error));
                    }
                    value
                } else {
                    json!({"kind": entry.kind, "content": entry.content})
                };
                rendered.push(compact_json(&value, budget.max(16), counter));
            }
            let trajectory = compact_json(&json!(rendered), recent_budget, counter);
            let prompt = format!("## Task\n{task}\n\n## Earlier history summary\n{history}\n\n## Recent trajectory\n{trajectory}");
            if counter.count(&prompt) <= max_tokens {
                break prompt;
            }
            if recent_budget <= 16 {
                // Preserve the three-section protocol even for exceptionally small budgets.
                break format!("## Task\n{}\n\n## Earlier history summary\n(context budget exhausted)\n\n## Recent trajectory\n[]", truncate(&task, max_tokens.saturating_sub(160), counter));
            }
            recent_budget /= 2;
        };
        PreparedRouterContext {
            token_budget: None,
            preparation_ms: 0,
            preparation: RouterPreparationMetrics::default(),
            input_tokens: counter.count(&user_prompt),
            budget_tokens: max_tokens,
            history_truncated: true,
            pending_tokens,
            entry_tokens,
            compression_records: Vec::new(),
            counter: counter.name(),
            user_prompt,
            summarized_through: self.summarized_through,
            observed_through: self.next_sequence.saturating_sub(1),
            omitted_through: self.omitted_through,
        }
    }
}

fn entry_for_prompt(entry: &RouterEntry) -> Value {
    if entry.kind == RouterEntryKind::Round {
        let mut value = entry.content.clone();
        if let Some(object) = value.as_object_mut() {
            object.insert("is_error".into(), json!(entry.is_error));
        }
        value
    } else {
        json!({"kind": entry.kind, "content": entry.content})
    }
}

/// A deterministic, Router-only projection of observed facts. These limits bound
/// evidence size, never the Agent loop; no model call or main-message rewrite occurs.
fn project_observation(mut value: Value, counter: &dyn RouterTokenCounter) -> Value {
    if let Some(assistant) = value.get_mut("assistant") {
        for key in ["text", "reasoning_content"] {
            if let Some(text) = assistant.get(key).and_then(Value::as_str) {
                assistant[key] = json!(excerpt(text, 512, counter));
            }
        }
        if let Some(calls) = assistant
            .get_mut("tool_calls")
            .and_then(Value::as_array_mut)
        {
            for call in calls {
                let name = call
                    .get("tool_name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if let Some(arguments) = call.get_mut("arguments").and_then(Value::as_object_mut) {
                    for (key, argument) in arguments {
                        let Some(text) = argument.as_str() else {
                            continue;
                        };
                        let budget = match (name.as_str(), key.as_str()) {
                            (
                                "edit" | "write" | "applypatch" | "apply_patch",
                                "old_string" | "new_string" | "content" | "patch",
                            ) => 384,
                            (_, "file_path" | "path" | "workdir" | "cmd" | "command") => 512,
                            _ => 256,
                        };
                        *argument = json!(excerpt(text, budget, counter));
                    }
                }
            }
        }
    }
    if let Some(results) = value.get_mut("tool_results").and_then(Value::as_array_mut) {
        for result in results {
            project_result(result, counter);
        }
    } else if value.get("tool_name").is_some() {
        // A tool result that arrived after a partial-round checkpoint is feedback.
        project_result(&mut value, counter);
    }
    value
}

fn project_result(result: &mut Value, counter: &dyn RouterTokenCounter) {
    let failed = result.get("is_error").and_then(Value::as_bool) == Some(true)
        || result
            .pointer("/status/exit_code")
            .and_then(Value::as_i64)
            .is_some_and(|code| code != 0)
        || result.pointer("/status/success").and_then(Value::as_bool) == Some(false)
        || ["timed_out", "interrupted"]
            .iter()
            .any(|key| result["status"][key].as_bool() == Some(true));
    result["is_error"] = json!(failed);
    let name = result
        .get("tool_name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if let Some(output) = result.get("result_for_assistant") {
        let output = output
            .as_str()
            .map(std::borrow::Cow::Borrowed)
            .unwrap_or_else(|| std::borrow::Cow::Owned(output.to_string()));
        // Errors can occur in a successful command's output too. The excerpts are
        // evidence, not a heuristic claim that a command succeeded or failed.
        let evidence = if failed
            || matches!(
                name.as_str(),
                "execcommand" | "writestdin" | "bash" | "terminal"
            ) {
            failure_evidence(&output, counter)
        } else {
            None
        };
        let budget = match name.as_str() {
            "read" | "readfile" => 512,
            "edit" | "write" | "applypatch" | "apply_patch" => 384,
            _ if failed => 1_024,
            _ => 768,
        };
        let projected = excerpt(&output, budget, counter);
        if let Some(evidence) = evidence {
            result["key_evidence"] = json!(evidence);
        }
        result["result_for_assistant"] = json!(projected);
    }
}

fn excerpt(text: &str, budget: usize, counter: &dyn RouterTokenCounter) -> String {
    // Collapse only exactly repeated adjacent lines. Do not fuzzy-deduplicate code,
    // reasoning, or separate observations that may have different execution states.
    let mut output = String::new();
    let mut previous = "";
    let mut repeats = 0usize;
    for line in text.split_inclusive('\n') {
        if line == previous && !previous.is_empty() {
            repeats += 1;
            continue;
        }
        if repeats > 0 {
            output.push_str(&format!("\n[omitted {repeats} exact repeated lines]\n"));
            repeats = 0;
        }
        output.push_str(line);
        previous = line;
    }
    if repeats > 0 {
        output.push_str(&format!("\n[omitted {repeats} exact repeated lines]\n"));
    }
    truncate(&output, budget, counter)
}

fn failure_evidence(text: &str, counter: &dyn RouterTokenCounter) -> Option<String> {
    // Scan once and retain bounded neighborhoods, including failures in the middle
    // of very large logs. No regex, tokenization of raw logs, or semantic summary.
    let mut before = VecDeque::<(usize, String)>::new();
    let mut selected = VecDeque::<(usize, String)>::new();
    let mut anchors = VecDeque::new();
    let mut following = 0usize;
    for (index, line) in text.lines().enumerate() {
        let lower = line.to_ascii_lowercase();
        let relevant = [
            "assert",
            "error",
            "traceback",
            "panic",
            "failed",
            "exception",
            "stack trace",
        ]
        .iter()
        .any(|pattern| lower.contains(pattern));
        if relevant {
            for (line_index, line) in &before {
                if selected.back().is_none_or(|(last, _)| last < line_index) {
                    selected.push_back((*line_index, line.clone()));
                }
            }
            following = 3;
        }
        // Bound capture by bytes. Tokenize only the final selected excerpt, not
        // every matching line (a failure log can contain hundreds of thousands).
        let mut end = line.len().min(1024);
        while !line.is_char_boundary(end) {
            end -= 1;
        }
        let bounded = if end < line.len() {
            format!("{} [omitted]", &line[..end])
        } else {
            line.to_string()
        };
        if relevant {
            anchors.push_back(bounded.clone());
            if anchors.len() > 8 {
                anchors.pop_front();
            }
        }
        if following > 0 {
            selected.push_back((index, bounded.clone()));
            following -= 1;
        }
        while selected.len() > 24 {
            selected.pop_front();
        }
        before.push_back((index, bounded));
        if before.len() > 2 {
            before.pop_front();
        }
    }
    if selected.is_empty() {
        return None;
    }
    let mut output = String::from("[selected failure-related output; other lines omitted]\n");
    let mut previous = None;
    for (index, line) in selected {
        if previous.is_some_and(|previous| index > previous + 1) {
            output.push_str("[omitted]\n");
        }
        output.push_str(&line);
        output.push('\n');
        previous = Some(index);
    }
    Some(format!(
        "Selected failure lines:\n{}\nSurrounding output:\n{}",
        truncate(
            &anchors.into_iter().collect::<Vec<_>>().join("\n"),
            640,
            counter
        ),
        truncate(&output, 320, counter)
    ))
}

/// UTF-8 safe, explicitly marked head/tail truncation, measured with the supplied tokenizer.
pub fn truncate(text: &str, budget: usize, counter: &dyn RouterTokenCounter) -> String {
    // Avoid tokenizing megabytes of logs/code on a routing boundary. This separate
    // source-size guard is an explicitly marked lossy projection, not token counting.
    if text.len() > 65_536 {
        let mut head = 16_384;
        while !text.is_char_boundary(head) {
            head -= 1;
        }
        let mut tail = text.len() - 16_384;
        while !text.is_char_boundary(tail) {
            tail += 1;
        }
        return truncate(
            &format!(
                "{}\n[source middle omitted]\n{}",
                &text[..head],
                &text[tail..]
            ),
            budget,
            counter,
        );
    }
    if counter.count(text) <= budget {
        return text.to_string();
    }
    let offsets: Vec<_> = text
        .char_indices()
        .map(|(offset, _)| offset)
        .chain(std::iter::once(text.len()))
        .collect();
    let mut low = 0;
    let mut high = offsets.len().saturating_sub(1);
    let mut best = String::new();
    while low <= high {
        let keep = low + (high - low) / 2;
        let head = keep / 2;
        let tail = keep - head;
        let candidate = format!(
            "{}\n[omitted]\n{}",
            &text[..offsets[head]],
            &text[offsets[offsets.len() - 1 - tail]..]
        );
        if counter.count(&candidate) <= budget {
            best = candidate;
            low = keep + 1;
        } else if keep == 0 {
            break;
        } else {
            high = keep - 1;
        }
    }
    best
}

pub fn compact_json(value: &Value, budget: usize, counter: &dyn RouterTokenCounter) -> Value {
    let rendered = value.to_string();
    if let Some(cached) = counter.cached_projection(&rendered, budget) {
        return cached;
    }
    let result = compact_json_uncached(value, &rendered, budget, counter);
    counter.remember_projection(&rendered, budget, &result);
    result
}

fn compact_json_uncached(
    value: &Value,
    rendered: &str,
    budget: usize,
    counter: &dyn RouterTokenCounter,
) -> Value {
    fn shrink(
        value: &Value,
        field_budget: usize,
        items: usize,
        counter: &dyn RouterTokenCounter,
    ) -> Value {
        match value {
            Value::String(text) => Value::String(truncate(text, field_budget, counter)),
            Value::Array(values) => {
                let mut retained: Vec<usize> = (0..values.len()).collect();
                // Prefer errors and recent results while preserving the retained chronology.
                retained.sort_by_key(|index| {
                    (
                        values[*index].get("is_error").and_then(Value::as_bool) != Some(true),
                        std::cmp::Reverse(*index),
                    )
                });
                retained.truncate(items);
                retained.sort_unstable();
                let mut output: Vec<_> = retained
                    .iter()
                    .map(|index| shrink(&values[*index], field_budget, items, counter))
                    .collect();
                if values.len() > output.len() {
                    output.insert(0, json!({"omitted_items": values.len() - output.len()}));
                }
                Value::Array(output)
            }
            Value::Object(object) => {
                let mut output: serde_json::Map<String, Value> = object
                    .iter()
                    .take(items.max(8))
                    .map(|(key, value)| (key.clone(), shrink(value, field_budget, items, counter)))
                    .collect();
                if object.len() > output.len() {
                    output.insert("omitted_fields".into(), json!(object.len() - output.len()));
                }
                Value::Object(output)
            }
            _ => value.clone(),
        }
    }
    if rendered.len() <= 65_536 && counter.count(&rendered) <= budget {
        return value.clone();
    }
    let mut fields = 1_024;
    let mut items = 32;
    loop {
        let compact = shrink(value, fields, items, counter);
        if counter.count(&compact.to_string()) <= budget {
            return compact;
        }
        if fields > 32 {
            fields /= 2;
        } else if items > 1 {
            items /= 2;
        } else {
            let preview = truncate(&rendered, budget.saturating_sub(48), counter);
            let result = json!({"truncated": true, "preview": preview});
            if counter.count(&result.to_string()) <= budget {
                return result;
            }
            return Value::Null;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summary_budget_admits_complete_text_without_cutting_multilingual_facts() {
        let budget = RouterSummaryBudget::new(3).unwrap();
        assert_eq!(budget.estimate(" abcdefghi \n"), 3);
        assert!(budget.accepts(" abcdefghi \n"));
        assert!(!budget.accepts("abcdefghij"));
        assert_eq!(budget.estimate("a你"), 3);
        assert!(budget.accepts("a你"));
        assert_eq!(budget.estimate("你🙂"), 4);
        assert!(!budget.accepts("你🙂"));
        assert!(!budget.accepts(""));
        assert!(!budget.accepts(" \t\n\u{3000}"));
        assert_eq!(budget.estimate(" \t\n\u{3000}"), 0);
    }

    #[test]
    fn summary_budget_reserves_rewrite_headroom_without_overflow() {
        assert!(RouterSummaryBudget::new(0).is_none());
        for (maximum, target) in [(1, 1), (2, 1), (3, 2), (4, 3), (2_048, 1_536)] {
            let budget = RouterSummaryBudget::new(maximum).unwrap();
            assert_eq!(budget.max_tokens(), maximum);
            assert_eq!(budget.target_tokens(), target);
        }
        let largest = RouterSummaryBudget::new(usize::MAX).unwrap();
        assert_eq!(largest.max_tokens(), usize::MAX);
        assert_eq!(
            largest.target_tokens(),
            ((usize::MAX as u128 * 3) / 4) as usize
        );
        assert!(largest.accepts("A retained fact"));
    }

    #[test]
    fn tool_projection_keeps_paths_ranges_changes_status_and_actual_excerpts() {
        let value = json!({"assistant": {
        "text": "Actual conclusion\nActual conclusion\nNext step",
        "reasoning_content": "Observed reasoning\nObserved reasoning\nNeed validation",
        "tool_calls": [
            {"tool_id": "read", "tool_name": "Read", "arguments": {"file_path": "src/parser.rs", "offset": 40, "limit": 60}},
            {"tool_id": "edit", "tool_name": "Edit", "arguments": {"file_path": "src/parser.rs", "old_string": format!("OLD_START{}OLD_END", "old ".repeat(3000)), "new_string": format!("NEW_START{}NEW_END", "new ".repeat(3000))}},
            {"tool_id": "cmd", "tool_name": "ExecCommand", "arguments": {"cmd": "cargo test parser", "workdir": "/testbed"}}
        ]}, "tool_results": [
            {"tool_id": "read", "tool_name": "Read", "status": {"start_line": 40, "end_line": 99}, "result_for_assistant": format!("Read lines 40-99 from src/parser.rs\nSTART_CODE{}END_CODE", "code ".repeat(3000))},
            {"tool_id": "edit", "tool_name": "Edit", "status": {"success": true}, "result_for_assistant": "Edit succeeded"},
            {"tool_id": "cmd", "tool_name": "ExecCommand", "status": {"exit_code": 1}, "is_error": false, "result_for_assistant": format!("{}\nAssertionError: expected two nodes\n  at parser.rs:42\n{}", "passing log\n".repeat(10_000), "cleanup log\n".repeat(10_000))}
        ]});
        let projected = project_observation(value.clone(), &Utf8ByteBudget);
        assert_eq!(
            projected.pointer("/assistant/tool_calls/0/arguments"),
            value.pointer("/assistant/tool_calls/0/arguments")
        );
        assert_eq!(projected["tool_results"][0]["status"]["start_line"], 40);
        assert_eq!(projected["tool_results"][1]["status"]["success"], true);
        assert_eq!(projected["tool_results"][2]["is_error"], true);
        let text = projected.to_string();
        for expected in [
            "OLD_START",
            "OLD_END",
            "NEW_START",
            "NEW_END",
            "START_CODE",
            "END_CODE",
            "cargo test parser",
            "AssertionError: expected two nodes",
            "parser.rs:42",
            "exact repeated lines",
            "Observed reasoning",
            "Next step",
        ] {
            assert!(text.contains(expected), "missing {expected}");
        }
        assert!(text.len() < 5_000);
        let cache = CachedRouterTokenCounter::new(Arc::new(Utf8ByteBudget));
        assert_eq!(projected, project_observation(value, &cache));
        let mut state = RouterContextState::default();
        state.append("tools".into(), RouterEntryKind::Round, projected, &cache);
        let prompt = state.prepare(3, 4_096, &cache).user_prompt;
        assert!(prompt.contains("AssertionError: expected two nodes"));
        assert!(prompt.contains("exit_code"));
    }

    #[test]
    fn exact_cache_preserves_prompts_across_budgets_updates_and_summaries() {
        let counter = CachedRouterTokenCounter::new(Arc::new(Utf8ByteBudget));
        let mut state = RouterContextState {
            task: "Fix parser 世界 🦀".into(),
            ..Default::default()
        };
        for index in 0..12 {
            state.append(index.to_string(), RouterEntryKind::Round,
                json!({"assistant": {"text": "reasoning snippet ".repeat(80)},
                    "tool_results": [{"is_error": index == 3, "result_for_assistant": format!("{index}: {}", "output 世界 ".repeat(200))}]}),
                &Utf8ByteBudget);
        }
        for budget in [512, 2048, 4096] {
            let original = state.prepare(3, budget, &Utf8ByteBudget);
            let cached = state.prepare(3, budget, &counter);
            assert_eq!(original.user_prompt, cached.user_prompt);
            assert_eq!(original.input_tokens, cached.input_tokens);
            let before = counter.metrics();
            assert_eq!(
                state.prepare(3, budget, &counter).user_prompt,
                original.user_prompt
            );
            assert_eq!(counter.metrics().since(before).encode_calls, 0);
        }
        state.append(
            "steer".into(),
            RouterEntryKind::UserUpdate,
            json!("Do not edit; continue verification"),
            &counter,
        );
        let work = state.summary_work(3, 4).unwrap();
        assert!(state.apply_summary(&work, "Earlier tests failed"));
        let original = state.prepare(3, 4096, &Utf8ByteBudget);
        let cached = state.prepare(3, 4096, &counter);
        assert_eq!(original.user_prompt, cached.user_prompt);
        assert!(cached.user_prompt.contains("continue verification"));
        assert!(counter.metrics().cache_hits > 0);
        assert!(counter.metrics().projection_hits > 0);
    }

    #[test]
    fn cache_is_bounded_thread_safe_and_does_not_reuse_failed_counts() {
        let counter = Arc::new(CachedRouterTokenCounter::with_limits(
            Arc::new(Utf8ByteBudget),
            2048,
            8,
        ));
        let handles: Vec<_> = (0..4)
            .map(|worker| {
                let counter = counter.clone();
                std::thread::spawn(move || {
                    for index in 0..100 {
                        let text = format!("{worker}-{index}-{}", "🌍".repeat(30));
                        assert_eq!(counter.count(&text), text.len());
                        let value = json!({"text": text});
                        assert_eq!(
                            compact_json(&value, 64, counter.as_ref()),
                            compact_json(&value, 64, &Utf8ByteBudget)
                        );
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let tokens = counter.tokens.lock().unwrap();
        assert!(tokens.bytes <= 2048 && tokens.entries <= 8);
        let projections = counter.projections.lock().unwrap();
        assert!(projections.bytes <= 2048 && projections.entries <= 8);

        struct FailingCounter(std::sync::atomic::AtomicBool);
        impl RouterTokenCounter for FailingCounter {
            fn count(&self, text: &str) -> usize {
                if self.cacheable() {
                    1
                } else {
                    text.len()
                }
            }
            fn name(&self) -> &'static str {
                "test"
            }
            fn cacheable(&self) -> bool {
                !self.0.load(Ordering::Relaxed)
            }
        }
        let inner = Arc::new(FailingCounter(std::sync::atomic::AtomicBool::new(false)));
        let cache = CachedRouterTokenCounter::new(inner.clone());
        assert_eq!(cache.count("changed counter"), 1);
        inner.0.store(true, Ordering::Relaxed);
        assert_eq!(cache.count("changed counter"), "changed counter".len());
        assert_eq!(
            CachedRouterTokenCounter::new(Arc::new(Utf8ByteBudget)).count("changed counter"),
            "changed counter".len()
        );
    }

    fn append_round(state: &mut RouterContextState, index: usize) {
        state.append(format!("m{index}"), RouterEntryKind::Round, json!({"round_id": index, "assistant": {"text": format!("step-{index}"), "tool_calls": []}, "tool_results": []}), &Utf8ByteBudget);
    }

    #[test]
    fn summary_trigger_uses_only_projected_pending_token_volume() {
        let mut state = RouterContextState::default();
        for index in 0..4 {
            append_round(&mut state, index);
        }
        let eligible_tokens = state.pending_tokens(3);
        assert_eq!(eligible_tokens, state.entries[0].token_count);
        assert!(state.summary_work(3, eligible_tokens + 1).is_none());
        let work = state.summary_work(3, eligible_tokens).unwrap();
        assert_eq!(work.pending_tokens, eligible_tokens);
        assert!(state.apply_summary(&work, "updated factual summary"));
        assert_eq!(state.summary, "updated factual summary");
    }

    #[test]
    fn bounded_summary_selects_the_largest_fitting_contiguous_prefix() {
        let mut state = RouterContextState {
            task: "Inspect the parser".into(),
            summary: "Existing factual history".into(),
            ..Default::default()
        };
        for index in 0..8 {
            append_round(&mut state, index);
        }
        let prefix: Vec<_> = state.entries.iter().take(2).collect();
        let budget = Utf8ByteBudget.count(&state.summary_work_for_prefix(&prefix).unwrap().prompt);
        let work = state
            .summary_work_bounded(3, 1, budget, &Utf8ByteBudget)
            .unwrap();
        assert_eq!(work.base_through, 0);
        assert_eq!(work.through, 2);
        assert_eq!(Utf8ByteBudget.count(&work.prompt), budget);
        assert_eq!(
            work.pending_tokens,
            state.entries[0].token_count + state.entries[1].token_count
        );
        assert!(work.prompt.contains("Existing factual history"));
        assert!(work.prompt.contains("step-0"));
        assert!(work.prompt.contains("step-1"));
        assert!(!work.prompt.contains("step-2"));
        assert!(!work.prompt.contains("step-7"));
        assert!(state
            .summary_work_bounded(3, usize::MAX, budget, &Utf8ByteBudget)
            .is_none());
    }

    #[test]
    fn bounded_summary_rejects_an_oversized_first_entry_or_summary_without_skipping_it() {
        let mut state = RouterContextState::default();
        append_round(&mut state, 0);
        append_round(&mut state, 1);
        let prefix: Vec<_> = state.entries.iter().take(1).collect();
        let first_size =
            Utf8ByteBudget.count(&state.summary_work_for_prefix(&prefix).unwrap().prompt);
        assert!(state
            .summary_work_bounded(0, 1, first_size - 1, &Utf8ByteBudget)
            .is_none());
        assert_eq!(state.entries.front().unwrap().sequence, 1);
        assert_eq!(state.entries.len(), 2);
        state.summary = "previous factual summary ".repeat(100);
        assert!(state
            .summary_work_bounded(0, 1, first_size, &Utf8ByteBudget)
            .is_none());
        assert!(RouterContextState::default()
            .summary_work_bounded(0, 0, 10_000, &Utf8ByteBudget)
            .is_none());
    }

    #[test]
    fn bootstrap_cursor_roundtrips_and_blocks_classification_until_host_merge() {
        let legacy = r#"{"task":"Inspect parser","omitted_through":40,"next_sequence":169}"#;
        let mut state: RouterContextState = serde_json::from_str(legacy).unwrap();
        assert!(state.history_bootstrap.is_none());
        assert!(state.history_coverage.is_empty());
        assert!(serde_json::to_value(&state)
            .unwrap()
            .get("history_bootstrap")
            .is_none());
        assert!(serde_json::to_value(&state)
            .unwrap()
            .get("history_coverage")
            .is_none());
        state.history_coverage = vec!["turn-one".into()];
        state.history_bootstrap = Some(RouterHistoryBootstrap {
            turn_ids: vec!["turn-one".into(), "turn-two".into()],
            turn_cursor: 1,
            entry_cursor: 7,
            complete: false,
        });
        let encoded = serde_json::to_value(&state).unwrap();
        let mut restored: RouterContextState = serde_json::from_value(encoded.clone()).unwrap();
        assert_eq!(serde_json::to_value(&restored).unwrap(), encoded);
        assert_eq!(restored.history_coverage, vec!["turn-one"]);
        let progress = restored.history_bootstrap.as_mut().unwrap();
        progress.complete = true;
        assert_eq!(progress.turn_cursor, 1);
        assert_eq!(progress.entry_cursor, 7);
        assert!(restored.prepare(3, 4096, &Utf8ByteBudget).history_truncated);
        // A finished worker is not proof that the missing prefix was rebuilt.
        assert_eq!(restored.omitted_through, 40);
        restored.history_bootstrap = None;
        assert!(restored.prepare(3, 4096, &Utf8ByteBudget).history_truncated);
        restored.omitted_through = 0;
        restored.history_bootstrap = Some(RouterHistoryBootstrap {
            complete: true,
            ..Default::default()
        });
        assert!(restored.prepare(3, 4096, &Utf8ByteBudget).history_truncated);
        restored.history_bootstrap = None;
        assert!(!restored.prepare(3, 4096, &Utf8ByteBudget).history_truncated);
    }

    #[test]
    fn incremental_bootstrap_summarizes_more_than_buffer_capacity_without_losing_observations() {
        let mut state = RouterContextState {
            task: "Inspect the parser".into(),
            history_bootstrap: Some(RouterHistoryBootstrap {
                turn_ids: vec!["old-turn".into()],
                ..Default::default()
            }),
            ..Default::default()
        };
        let budget = 1500;
        let mut summarized_count = 0;
        let mut batches = 0;
        for index in 0..250 {
            assert!(!state.observation_buffer_full());
            append_round(&mut state, index);
            state.history_bootstrap.as_mut().unwrap().entry_cursor = index + 1;
            if state.entries.len() >= 24 || index == 249 {
                while state.entries.len() > 3 {
                    let cursor = state.history_bootstrap.as_ref().unwrap().entry_cursor;
                    let work = state
                        .summary_work_bounded(3, 1, budget, &Utf8ByteBudget)
                        .unwrap();
                    assert!(Utf8ByteBudget.count(&work.prompt) <= budget);
                    assert_eq!(work.omitted_through, 0);
                    assert_eq!(work.base_through, summarized_count);
                    assert!(work.through > summarized_count);
                    summarized_count = work.through;
                    assert!(state.apply_summary(
                        &work,
                        &format!("Verified history through step {}", work.through - 1)
                    ));
                    assert_eq!(
                        state.history_bootstrap.as_ref().unwrap().entry_cursor,
                        cursor
                    );
                    assert_eq!(state.omitted_through, 0);
                    assert!(state.prepare(3, 65_536, &Utf8ByteBudget).history_truncated);
                    batches += 1;
                }
                // A host can persist accepted progress after any chunk and resume it.
                state = serde_json::from_value(serde_json::to_value(&state).unwrap()).unwrap();
            }
        }
        assert!(batches > 1);
        assert_eq!(summarized_count, 247);
        assert_eq!(state.entries.front().unwrap().sequence, 248);
        assert_eq!(state.entries.back().unwrap().sequence, 250);
        assert_eq!(state.history_bootstrap.as_ref().unwrap().entry_cursor, 250);
        assert_eq!(state.omitted_through, 0);
        state.history_bootstrap.as_mut().unwrap().complete = true;
        assert!(state.prepare(3, 65_536, &Utf8ByteBudget).history_truncated);
        state.history_bootstrap = None;
        assert!(!state.prepare(3, 65_536, &Utf8ByteBudget).history_truncated);
    }

    #[test]
    fn bootstrap_can_flush_feedback_without_waiting_for_an_assistant_round() {
        let mut state = RouterContextState::default();
        state.append(
            "feedback".into(),
            RouterEntryKind::Feedback,
            json!("The process exited with code 1"),
            &Utf8ByteBudget,
        );
        assert!(state.summary_work(1, 1).is_none());
        let work = state
            .summary_work_bounded(0, 1, 4096, &Utf8ByteBudget)
            .unwrap();
        assert_eq!(work.through, 1);
        assert!(work.prompt.contains("The process exited with code 1"));
        assert!(state.apply_summary(&work, "The process failed with exit code 1"));
        assert!(state.entries.is_empty());
    }

    #[test]
    fn delayed_summary_covers_only_its_snapshot_and_keeps_new_evidence() {
        let mut state = RouterContextState::default();
        for index in 0..8 {
            append_round(&mut state, index);
        }
        let work = state.summary_work(3, 4).unwrap();
        append_round(&mut state, 8);
        assert!(state.apply_summary(&work, "Earlier factual summary"));
        assert_eq!(state.entries.front().unwrap().sequence, work.through + 1);
        let prompt = state.prepare(3, 4096, &Utf8ByteBudget).user_prompt;
        assert!(prompt.contains("Earlier factual summary"));
        assert!(prompt.contains("step-8"));
        assert!(!state.apply_summary(&work, "stale"));
    }

    #[test]
    fn bounded_log_projection_is_complete_router_input() {
        let mut state = RouterContextState {
            task: "Inspect the failing parser test".into(),
            ..Default::default()
        };
        state.append(
            "long-log".into(),
            RouterEntryKind::Round,
            json!({
                "tool_results": [{
                    "tool_name": "ReadFile",
                    "result_for_assistant": "large log entry\n".repeat(10_000)
                }]
            }),
            &Utf8ByteBudget,
        );
        let prepared = state.prepare(3, 4096, &Utf8ByteBudget);
        assert!(prepared.user_prompt.contains("omitted"));
        assert!(prepared.input_tokens <= prepared.budget_tokens);
        assert!(!prepared.history_truncated);
    }

    #[test]
    fn accepted_summary_restores_complete_input_after_history_outgrows_budget() {
        let mut state = RouterContextState {
            task: "Inspect parser behavior".into(),
            ..Default::default()
        };
        for index in 0..60 {
            append_round(&mut state, index);
        }
        let latest = "Do not edit; inspect the failing test first";
        state.append(
            "latest".into(),
            RouterEntryKind::UserUpdate,
            json!(latest),
            &Utf8ByteBudget,
        );
        let before = state.prepare(3, 2048, &Utf8ByteBudget);
        assert!(before.history_truncated);
        assert!(before.input_tokens <= before.budget_tokens);
        assert!(before.user_prompt.contains(latest));

        let work = state.summary_work(3, 1).unwrap();
        assert!(state.apply_summary(&work, "Earlier parser inspection identified a failing test"));
        let after = state.prepare(3, 2048, &Utf8ByteBudget);
        assert!(!after.history_truncated);
        assert!(after.user_prompt.contains(latest));
        assert!(after.user_prompt.contains("step-59"));
        assert!(after.input_tokens <= after.budget_tokens);
    }

    #[test]
    fn captured_summary_only_recovers_dropped_observations_inside_its_snapshot() {
        for total_rounds in [200, 240] {
            let mut state = RouterContextState::default();
            for index in 0..100 {
                append_round(&mut state, index);
            }
            let captured = state.summary_work(3, 1).unwrap();
            for index in 100..total_rounds {
                append_round(&mut state, index);
            }
            let omitted_before = state.omitted_through;
            assert!(omitted_before > 0);
            assert!(state.prepare(3, 65_536, &Utf8ByteBudget).history_truncated);
            assert!(state.apply_summary(&captured, "Captured parser history through step 96"));
            let prepared = state.prepare(3, 65_536, &Utf8ByteBudget);
            if total_rounds == 200 {
                assert!(!prepared.history_truncated);
                assert_eq!(prepared.omitted_through, 0);
            } else {
                assert!(prepared.history_truncated);
                assert_eq!(prepared.omitted_through, omitted_before);
            }
            assert!(prepared
                .user_prompt
                .contains(&format!("step-{}", total_rounds - 1)));
        }
    }

    #[test]
    fn a_new_summary_cannot_recover_history_missing_before_its_snapshot() {
        // Legacy sidecars and current buffer backpressure use the same explicit
        // missing-history cursor; deserialization must preserve that evidence.
        let mut state: RouterContextState = serde_json::from_str(
            r#"{"task":"Inspect parser","omitted_through":72,"next_sequence":73}"#,
        )
        .unwrap();
        for index in 72..80 {
            append_round(&mut state, index);
        }
        let captured = state.summary_work(3, 1).unwrap();
        assert_eq!(captured.omitted_through, 72);
        assert!(state.apply_summary(
            &captured,
            "Available parser evidence after a missing prefix"
        ));
        let prepared = state.prepare(3, 65_536, &Utf8ByteBudget);
        assert!(prepared.history_truncated);
        assert_eq!(prepared.omitted_through, 72);
        assert!(prepared
            .user_prompt
            .contains("Earlier observations omitted through sequence: 72"));
        assert!(prepared.input_tokens <= prepared.budget_tokens);
    }

    #[test]
    fn huge_multilingual_context_is_bounded_and_latest_update_survives() {
        let mut state = RouterContextState {
            task: "任务 code 🦀 ".repeat(10_000),
            ..Default::default()
        };
        for index in 0..8 {
            append_round(&mut state, index);
        }
        state.append(
            "steer".into(),
            RouterEntryKind::UserUpdate,
            json!("Do not edit; inspect the failing test first"),
            &Utf8ByteBudget,
        );
        for budget in [512, 2048, 4096] {
            let prepared = state.prepare(3, budget, &Utf8ByteBudget);
            assert!(
                prepared.input_tokens <= budget,
                "{} > {budget}",
                prepared.input_tokens
            );
            assert!(prepared.user_prompt.contains("## Recent trajectory"));
            let trajectory = prepared
                .user_prompt
                .split("## Recent trajectory\n")
                .nth(1)
                .unwrap();
            serde_json::from_str::<Value>(trajectory).unwrap();
        }
        assert!(state
            .prepare(3, 4096, &Utf8ByteBudget)
            .user_prompt
            .contains("Do not edit"));
    }

    #[test]
    fn estimated_multilingual_context_keeps_latest_steering_after_usage_calibration_and_restore() {
        let counter = CachedRouterTokenCounter::new(Arc::new(EstimatedRouterTokens));
        let mut state = RouterContextState {
            task: "Inspect parser behavior ASCII identifiers 中文上下文 🦀🙂 ".repeat(10_000),
            ..Default::default()
        };
        let output = "identifier_0123456789 punctuation={}[] 中文执行结果 🦀🙂 ".repeat(4_000);
        assert!(output.len() > 65_536);
        for index in 0..10 {
            state.append(
                format!("round-{index}"),
                RouterEntryKind::Round,
                json!({
                    "round_id": index,
                    "assistant": {"text": format!("Inspect parser step {index}")},
                    "tool_results": [{
                        "tool_name": "ExecCommand",
                        "is_error": index == 9,
                        "result_for_assistant": format!("{output}\nAssertionError: parser evidence {index}")
                    }]
                }),
                &counter,
            );
        }
        let latest = "VERIFY_ONLY 最新要求：只检查解析器，不修改代码 🙂";
        state.append(
            "latest".into(),
            RouterEntryKind::UserUpdate,
            json!(latest),
            &counter,
        );

        let budget = RouterInputBudget::new(8_192, 8_192, counter.count("Classify the next step"));
        let before = state.prepare(3, budget.user_budget(), &counter);
        assert!(before.input_tokens <= before.budget_tokens);
        assert!(before.user_prompt.contains(latest));
        let pending_before = state.pending_tokens(3);
        budget.observe_usage(before.input_tokens, (before.input_tokens + 512) * 2);
        assert!(budget.user_budget() < before.budget_tokens);
        assert_eq!(state.pending_tokens(3), pending_before);
        let after = state.prepare(3, budget.user_budget(), &counter);
        assert!(after.input_tokens <= after.budget_tokens);
        assert!(after.user_prompt.contains(latest));
        serde_json::from_str::<Value>(
            after
                .user_prompt
                .split("## Recent trajectory\n")
                .nth(1)
                .unwrap(),
        )
        .unwrap();

        // Legacy sidecars have no projected token counts. Recount with the new
        // execution's estimator rather than trusting zero/default metadata.
        let mut checkpoint = serde_json::to_value(&state).unwrap();
        for entry in checkpoint["entries"].as_array_mut().unwrap() {
            entry.as_object_mut().unwrap().remove("token_count");
        }
        let mut restored: RouterContextState = serde_json::from_value(checkpoint).unwrap();
        assert_eq!(restored.pending_tokens(3), 0);
        let restored_counter = CachedRouterTokenCounter::new(Arc::new(EstimatedRouterTokens));
        restored.refresh_token_counts(&restored_counter);
        assert_eq!(restored.pending_tokens(3), pending_before);
        let restored_prompt = restored.prepare(3, budget.user_budget(), &restored_counter);
        assert!(restored_prompt.input_tokens <= restored_prompt.budget_tokens);
        assert_eq!(restored_prompt.user_prompt, after.user_prompt);
        assert!(restored_prompt.user_prompt.contains(latest));
    }

    #[test]
    fn missing_summary_keeps_earlier_observations_and_serialization_defaults() {
        let mut state: RouterContextState = serde_json::from_str(r#"{"task":"fix bug"}"#).unwrap();
        for index in 0..6 {
            append_round(&mut state, index);
        }
        let prompt = state.prepare(3, 4096, &Utf8ByteBudget).user_prompt;
        assert!(prompt.contains("step-0"));
        assert!(prompt.contains("step-5"));
        assert!(state.claim_message("message-1"));
        let mut restored: RouterContextState =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert!(!restored.claim_message("message-1"));
        assert_eq!(restored.version, 1);
    }

    #[test]
    fn failed_summary_backlog_is_bounded_with_explicit_omission() {
        let mut state = RouterContextState::default();
        for index in 0..200 {
            append_round(&mut state, index);
        }
        assert_eq!(state.entries.len(), 128);
        assert_eq!(state.omitted_through, 72);
        assert_eq!(state.observed_rounds, 200);
        let work = state.summary_work(3, 4).unwrap();
        assert_eq!(work.through, 197);
        let prepared = state.prepare(3, 4096, &Utf8ByteBudget);
        assert!(prepared.user_prompt.contains("step-199"));
        assert_eq!(prepared.omitted_through, 72);
        assert!(prepared.input_tokens <= 4096);
    }

    #[test]
    fn large_output_is_projected_before_expensive_tokenization_and_keeps_errors() {
        struct CheckedCounter;
        impl RouterTokenCounter for CheckedCounter {
            fn count(&self, text: &str) -> usize {
                assert!(
                    text.len() <= 65_536,
                    "raw logs must not reach the tokenizer"
                );
                text.len()
            }
            fn name(&self) -> &'static str {
                "checked_byte_count"
            }
        }
        let tools: Vec<_> = (0..40).map(|index| json!({
            "tool_id": index, "is_error": index == 0,
            "result_for_assistant": if index == 0 { "CRITICAL_ASSERTION_FAILURE".to_string() } else { "large log 世界 ".repeat(10_000) }
        })).collect();
        let mut state = RouterContextState::default();
        state.append(
            "error-round".into(),
            RouterEntryKind::Round,
            json!({"assistant": {"text": "test"}, "tool_results": tools}),
            &CheckedCounter,
        );
        assert!(state.entries[0].is_error);
        let prepared = state.prepare(3, 4096, &CheckedCounter);
        assert!(prepared.user_prompt.contains("CRITICAL_ASSERTION_FAILURE"));
        assert!(prepared.user_prompt.contains("omitted"));
        assert!(prepared.input_tokens <= 4096);
    }
}
