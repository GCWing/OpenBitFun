#[cfg(feature = "token-usage-statistics")]
use super::time_zone::{local_date_start_utc, parse_time_zone};
use super::types::{
    ModelTokenStats, SessionTokenStats, TimeRange, TokenUsageQuery, TokenUsageRecord,
    TokenUsageSummary,
};
use chrono::{DateTime, Datelike, Duration, NaiveDate, Utc};
#[cfg(feature = "token-usage-statistics")]
use chrono_tz::Tz;
use log::{debug, info, warn};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::fs;
use tokio::sync::{Mutex, RwLock};

const MODEL_STATS_FILE: &str = "model_stats.json";
const RECORDS_DIR: &str = "records";
// Old daily-batch writers do not enumerate this directory. Keeping it under
// records also preserves the legacy explicit clear-all operation's scope.
const MODEL_ATTEMPTS_DIR: &str = "model-attempts";

#[derive(Clone)]
pub struct TokenUsageService {
    base_dir: PathBuf,
    model_stats: Arc<RwLock<HashMap<String, ModelTokenStats>>>,
    session_cache: Arc<RwLock<HashMap<String, SessionTokenStats>>>,
    record_batches: Arc<Mutex<HashMap<String, Arc<Mutex<RecordsBatch>>>>>,
    usage_lifecycle: Arc<RwLock<()>>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RecordsBatch {
    records: Vec<TokenUsageRecord>,
}

impl TokenUsageService {
    pub async fn new(base_dir: PathBuf) -> Result<Self, String> {
        let service = Self::for_queries(base_dir);

        service.init_storage().await?;
        service.load_model_stats().await?;

        info!("Token usage service initialized");
        Ok(service)
    }

    /// Read persisted records without initializing directories or repairing
    /// aggregate statistics. Runtime writers must use `new` instead.
    pub fn for_queries(base_dir: PathBuf) -> Self {
        Self {
            base_dir,
            model_stats: Arc::new(RwLock::new(HashMap::new())),
            session_cache: Arc::new(RwLock::new(HashMap::new())),
            record_batches: Arc::new(Mutex::new(HashMap::new())),
            usage_lifecycle: Arc::new(RwLock::new(())),
        }
    }

    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    async fn init_storage(&self) -> Result<(), String> {
        let records_dir = self.base_dir.join(RECORDS_DIR);

        fs::create_dir_all(&self.base_dir)
            .await
            .map_err(|e| format!("Failed to create token usage directory: {}", e))?;
        fs::create_dir_all(&records_dir)
            .await
            .map_err(|e| format!("Failed to create records directory: {}", e))?;

        debug!("Token usage storage initialized at: {:?}", self.base_dir);
        Ok(())
    }

    fn get_model_stats_path(&self) -> PathBuf {
        self.base_dir.join(MODEL_STATS_FILE)
    }

    fn get_records_path_for_key(&self, date_key: &str) -> PathBuf {
        self.base_dir
            .join(RECORDS_DIR)
            .join(format!("{}.json", date_key))
    }

    fn get_attempts_path_for_key(&self, date_key: &str) -> PathBuf {
        self.base_dir
            .join(RECORDS_DIR)
            .join(MODEL_ATTEMPTS_DIR)
            .join(format!("{date_key}.json"))
    }

    async fn load_model_stats(&self) -> Result<(), String> {
        let path = self.get_model_stats_path();

        if !path.exists() {
            debug!("No existing model stats file found");
            return Ok(());
        }

        let content = match fs::read_to_string(&path).await {
            Ok(c) => c,
            Err(e) => {
                warn!("Failed to read model stats file, starting fresh: {}", e);
                return Ok(());
            }
        };

        let stats: HashMap<String, ModelTokenStats> = match serde_json::from_str(&content) {
            Ok(s) => s,
            Err(e) => {
                warn!("Failed to parse model stats file, starting fresh: {}", e);
                let backup_path = path.with_extension("json.bak");
                if let Err(backup_err) = fs::rename(&path, &backup_path).await {
                    warn!(
                        "Failed to backup corrupted model stats file: {}",
                        backup_err
                    );
                }
                return Ok(());
            }
        };

        let mut model_stats = self.model_stats.write().await;
        *model_stats = stats;

        info!("Loaded statistics for {} models", model_stats.len());
        Ok(())
    }

    async fn save_model_stats(&self) -> Result<(), String> {
        let path = self.get_model_stats_path();
        let model_stats = self.model_stats.read().await;

        let content = serde_json::to_string_pretty(&*model_stats)
            .map_err(|e| format!("Failed to serialize model stats: {}", e))?;

        fs::write(&path, content)
            .await
            .map_err(|e| format!("Failed to write model stats file: {}", e))?;

        debug!("Saved statistics for {} models", model_stats.len());
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn record_usage(
        &self,
        model_config_id: String,
        effective_model_name: String,
        session_id: String,
        turn_id: String,
        input_tokens: u32,
        output_tokens: u32,
        cached_tokens: Option<u32>,
        token_details: Option<serde_json::Value>,
        is_subagent: bool,
    ) -> Result<(), String> {
        let service = self.clone();
        // Once accepted, finish the ledger transaction even if a model turn
        // stops awaiting it. Locks and atomic replacement belong to this task.
        tokio::spawn(async move {
            service
                .record_usage_inner(
                    model_config_id,
                    effective_model_name,
                    session_id,
                    turn_id,
                    input_tokens,
                    output_tokens,
                    cached_tokens,
                    token_details,
                    is_subagent,
                )
                .await
        })
        .await
        .map_err(|_| "Token usage writer task stopped".to_string())?
    }

    #[allow(clippy::too_many_arguments)]
    async fn record_usage_inner(
        &self,
        model_config_id: String,
        effective_model_name: String,
        session_id: String,
        turn_id: String,
        input_tokens: u32,
        output_tokens: u32,
        cached_tokens: Option<u32>,
        token_details: Option<serde_json::Value>,
        is_subagent: bool,
    ) -> Result<(), String> {
        let _usage_guard = self.usage_lifecycle.read().await;
        let context = super::types::model_request_context(token_details.as_ref())?;
        if context.as_ref().is_some_and(|context| !context.usage_known)
            && (input_tokens != 0 || output_tokens != 0 || cached_tokens.is_some())
        {
            return Err("Unknown model usage cannot carry fabricated token counters".into());
        }
        let now = context
            .as_ref()
            .map(|context| context.started_at)
            .unwrap_or_else(Utc::now);
        let total_tokens = input_tokens
            .checked_add(output_tokens)
            .ok_or_else(|| "Token usage counter overflow".to_string())?;
        let cached_tokens_available = cached_tokens.is_some();
        let cached_tokens = cached_tokens.unwrap_or(0);
        let cache_write_tokens: u32 = token_details
            .as_ref()
            .and_then(|details| details.get("cacheCreationTokenCount"))
            .and_then(|value| value.as_u64())
            .map(|value| value as u32)
            .unwrap_or(0);

        let record = TokenUsageRecord {
            model_config_id: model_config_id.clone(),
            effective_model_name: effective_model_name.clone(),
            session_id: session_id.clone(),
            turn_id,
            timestamp: now,
            input_tokens,
            output_tokens,
            cached_tokens,
            cached_tokens_available,
            cache_write_tokens,
            total_tokens,
            token_details,
            is_subagent,
        };

        if !self.persist_record(&record).await? {
            return Ok(());
        }
        self.update_model_stats(&record).await?;
        self.update_session_cache(&record).await?;

        debug!(
            "Recorded token usage: model_config_id={}, effective_model_name={}, session={}, input={}, output={}, total={}, is_subagent={}",
            model_config_id,
            effective_model_name,
            session_id,
            input_tokens,
            output_tokens,
            total_tokens,
            is_subagent
        );

        Ok(())
    }

    async fn update_model_stats(&self, record: &TokenUsageRecord) -> Result<(), String> {
        let mut model_stats = self.model_stats.write().await;

        let stats = model_stats
            .entry(record.effective_model_name.clone())
            .or_insert_with(|| ModelTokenStats {
                model_id: record.effective_model_name.clone(),
                ..Default::default()
            });

        stats.total_input += record.input_tokens as u64;
        stats.total_output += record.output_tokens as u64;
        stats.total_cached += record.cached_tokens as u64;
        stats.total_cache_write += record.cache_write_tokens as u64;
        if record.cached_tokens_available {
            stats.cache_reported_input_tokens += record.input_tokens as u64;
        }
        stats.total_tokens += record.total_tokens as u64;
        stats.request_count += 1;

        if stats.session_ids.insert(record.session_id.clone()) {
            stats.session_count += 1;
        }

        if stats.first_used.is_none() {
            stats.first_used = Some(record.timestamp);
        }
        stats.last_used = Some(record.timestamp);

        drop(model_stats);
        self.save_model_stats().await
    }

    async fn update_session_cache(&self, record: &TokenUsageRecord) -> Result<(), String> {
        let mut session_cache = self.session_cache.write().await;

        let stats = session_cache
            .entry(record.session_id.clone())
            .or_insert_with(|| SessionTokenStats {
                session_id: record.session_id.clone(),
                model_id: record.effective_model_name.clone(),
                total_input: 0,
                total_output: 0,
                total_cached: 0,
                total_cache_write: 0,
                cache_reported_input_tokens: 0,
                total_tokens: 0,
                request_count: 0,
                created_at: record.timestamp,
                last_updated: record.timestamp,
            });

        stats.total_input += record.input_tokens;
        stats.total_output += record.output_tokens;
        stats.total_cached += record.cached_tokens;
        stats.total_cache_write += record.cache_write_tokens;
        if record.cached_tokens_available {
            stats.cache_reported_input_tokens += record.input_tokens;
        }
        stats.total_tokens += record.total_tokens;
        stats.request_count += 1;
        stats.last_updated = record.timestamp;

        Ok(())
    }

    async fn persist_record(&self, record: &TokenUsageRecord) -> Result<bool, String> {
        let date_key = records_date_key(record.timestamp);
        let path = self.get_records_path_for_key(&date_key);
        if record.request_context().is_some() {
            // Promote earlier native records from this date before the next
            // legacy cached batch can overwrite them. No legacy data is removed.
            let legacy = crate::json_store::JsonFileStore
                .read_optional::<serde_json::Value>(&path)
                .await;
            let seeds = legacy
                .as_ref()
                .ok()
                .and_then(|value| value.as_ref())
                .and_then(|value| value.get("records"))
                .and_then(serde_json::Value::as_array)
                .map(|records| {
                    records
                        .iter()
                        .filter(|value| raw_attempt_id(value).is_some())
                        .cloned()
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let inserted = self
                .persist_record_at(
                    record,
                    &format!("{MODEL_ATTEMPTS_DIR}/{date_key}"),
                    &self.get_attempts_path_for_key(&date_key),
                    true,
                    seeds,
                )
                .await?;
            // The projection is useful to older readers, but is not authority.
            // A failed or stale legacy write must not undo an accepted attempt.
            if let Err(error) = self
                .persist_record_at(record, &date_key, &path, false, Vec::new())
                .await
            {
                warn!("Model usage compatibility projection failed; authoritative attempt was retained: {error}");
            }
            return Ok(inserted);
        }
        self.persist_record_at(record, &date_key, &path, false, Vec::new())
            .await
    }

    async fn persist_record_at(
        &self,
        record: &TokenUsageRecord,
        cache_key: &str,
        path: &Path,
        authoritative: bool,
        seeds: Vec<serde_json::Value>,
    ) -> Result<bool, String> {
        let batch_lock = self.record_batch_for_key(cache_key, path).await?;
        let mut batch = batch_lock.lock().await;
        let store = crate::json_store::JsonFileStore;
        let _transaction = store
            .acquire_cross_process_lock(path)
            .await
            .map_err(|error| error.to_string())?;
        // Read afresh under the host lock. Keeping the raw document preserves
        // unknown batch/record fields written by another supported version.
        let mut raw: serde_json::Value = store
            .read_optional(path)
            .await
            .map_err(|error| error.to_string())?
            .unwrap_or_else(|| {
                if authoritative {
                    serde_json::json!({"version":1,"records":[]})
                } else {
                    serde_json::json!({"records":[]})
                }
            });
        if authoritative {
            validate_attempt_batch(&raw)?;
        }
        let records = raw
            .get_mut("records")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| "Token usage record batch must contain an array".to_string())?;
        let mut identities: HashSet<String> = records
            .iter()
            .filter_map(raw_attempt_id)
            .map(str::to_owned)
            .collect();
        let mut promoted = false;
        for seed in seeds {
            if let Some(id) = raw_attempt_id(&seed) {
                if identities.insert(id.to_string()) {
                    records.push(seed);
                    promoted = true;
                }
            }
        }
        let mut current: RecordsBatch = serde_json::from_value(raw.clone()).map_err(|error| {
            format!("Failed to read token usage records; existing data was preserved: {error}")
        })?;
        if let Some(context) = record.request_context() {
            if let Some(existing) = current.records.iter().find(|existing| {
                existing
                    .token_details
                    .as_ref()
                    .and_then(|details| details.get(super::types::MODEL_REQUEST_CONTEXT_KEY))
                    .and_then(|context| context.get("attemptId"))
                    .and_then(serde_json::Value::as_str)
                    == Some(context.attempt_id.as_str())
            }) {
                let mut comparable = existing.clone();
                comparable.timestamp = record.timestamp;
                if serde_json::to_value(comparable).map_err(|error| error.to_string())?
                    != serde_json::to_value(record).map_err(|error| error.to_string())?
                {
                    return Err("Conflicting token usage for the same model attempt; existing record was preserved".into());
                }
                *batch = current;
                // A duplicate may have just promoted a pre-authority record.
                if authoritative && promoted {
                    store
                        .write_atomic_strict(path, &raw)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                return Ok(false);
            }
        }
        raw.get_mut("records")
            .and_then(serde_json::Value::as_array_mut)
            .ok_or_else(|| "Token usage record batch must contain an array".to_string())?
            .push(serde_json::to_value(record).map_err(|error| error.to_string())?);
        store
            .write_atomic_strict(path, &raw)
            .await
            .map_err(|error| error.to_string())?;
        current.records.push(record.clone());
        *batch = current;
        Ok(true)
    }

    async fn record_batch_for_key(
        &self,
        date_key: &str,
        path: &Path,
    ) -> Result<Arc<Mutex<RecordsBatch>>, String> {
        {
            let record_batches = self.record_batches.lock().await;
            if let Some(batch) = record_batches.get(date_key) {
                return Ok(Arc::clone(batch));
            }
        }

        let loaded_batch = read_records_batch(path).await?;
        let mut record_batches = self.record_batches.lock().await;
        Ok(Arc::clone(
            record_batches
                .entry(date_key.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(loaded_batch))),
        ))
    }

    pub async fn get_model_stats(&self, model_id: &str) -> Option<ModelTokenStats> {
        let model_stats = self.model_stats.read().await;
        model_stats.get(model_id).cloned()
    }

    pub async fn get_model_stats_filtered(
        &self,
        model_id: &str,
        time_range: TimeRange,
        include_subagent: bool,
    ) -> Result<Option<ModelTokenStats>, String> {
        let query = TokenUsageQuery {
            model_id: Some(model_id.to_string()),
            session_id: None,
            time_range,
            time_zone: None,
            limit: None,
            offset: None,
            include_subagent,
        };

        let records = self.query_records(query).await?;
        if records.is_empty() {
            return Ok(None);
        }

        let mut stats = ModelTokenStats {
            model_id: model_id.to_string(),
            ..Default::default()
        };

        for record in &records {
            stats.total_input += record.input_tokens as u64;
            stats.total_output += record.output_tokens as u64;
            stats.total_cached += record.cached_tokens as u64;
            stats.total_cache_write += record.cache_write_tokens as u64;
            if record.cached_tokens_available {
                stats.cache_reported_input_tokens += record.input_tokens as u64;
            }
            stats.total_tokens += record.total_tokens as u64;
            stats.request_count += 1;
            stats.session_ids.insert(record.session_id.clone());

            if stats.first_used.is_none() || Some(record.timestamp) < stats.first_used {
                stats.first_used = Some(record.timestamp);
            }
            if stats.last_used.is_none() || Some(record.timestamp) > stats.last_used {
                stats.last_used = Some(record.timestamp);
            }
        }

        stats.session_count = stats.session_ids.len() as u32;
        Ok(Some(stats))
    }

    pub async fn get_all_model_stats(&self) -> HashMap<String, ModelTokenStats> {
        let model_stats = self.model_stats.read().await;
        model_stats.clone()
    }

    pub async fn get_session_stats(&self, session_id: &str) -> Option<SessionTokenStats> {
        let session_cache = self.session_cache.read().await;
        session_cache.get(session_id).cloned()
    }

    pub async fn query_records(
        &self,
        query: TokenUsageQuery,
    ) -> Result<Vec<TokenUsageRecord>, String> {
        self.query_records_filtered(query, None).await
    }

    /// Query records while bounding the returned and retained set to the
    /// supplied session identities. The date files are still scanned once,
    /// but unrelated records never accumulate in the request's working set.
    pub async fn query_records_for_sessions(
        &self,
        query: TokenUsageQuery,
        session_ids: &HashSet<String>,
    ) -> Result<Vec<TokenUsageRecord>, String> {
        self.query_records_filtered(query, Some(session_ids)).await
    }

    async fn query_records_filtered(
        &self,
        query: TokenUsageQuery,
        session_ids: Option<&HashSet<String>>,
    ) -> Result<Vec<TokenUsageRecord>, String> {
        let _usage_guard = self.usage_lifecycle.read().await;
        let time_bounds = resolve_time_bounds(&query, Utc::now())?;
        let record_paths = self.record_paths_for_range(time_bounds).await?;
        let offset = query.offset.unwrap_or(0);
        let limit = query.limit.unwrap_or(usize::MAX);
        if limit == 0 {
            return Ok(Vec::new());
        }
        let mut matched = 0usize;
        let mut records = Vec::new();

        for path in record_paths {
            let date_key = path
                .file_stem()
                .and_then(|value| value.to_str())
                .ok_or_else(|| "Invalid token usage record date".to_string())?;
            let batch = self.read_daily_records(date_key).await?;
            {
                for record in batch.records {
                    if time_bounds.is_some_and(|(start, end)| {
                        record.timestamp < start || record.timestamp >= end
                    }) {
                        continue;
                    }
                    if !query.include_subagent && record.is_subagent {
                        continue;
                    }
                    if query
                        .model_id
                        .as_ref()
                        .is_some_and(|model_id| &record.effective_model_name != model_id)
                    {
                        continue;
                    }
                    if query
                        .session_id
                        .as_ref()
                        .is_some_and(|session_id| &record.session_id != session_id)
                    {
                        continue;
                    }
                    if session_ids
                        .is_some_and(|session_ids| !session_ids.contains(&record.session_id))
                    {
                        continue;
                    }
                    if matched < offset {
                        matched += 1;
                        continue;
                    }
                    records.push(record);
                    if records.len() == limit {
                        return Ok(records);
                    }
                }
            }
        }
        Ok(records)
    }

    async fn read_daily_records(&self, date_key: &str) -> Result<RecordsBatch, String> {
        let store = crate::json_store::JsonFileStore;
        let attempts = match store
            .read_optional::<serde_json::Value>(&self.get_attempts_path_for_key(date_key))
            .await
            .map_err(|error| error.to_string())?
        {
            Some(raw) => {
                validate_attempt_batch(&raw)?;
                serde_json::from_value::<RecordsBatch>(raw).map_err(|error| {
                    format!("Failed to read authoritative model usage; existing data was preserved: {error}")
                })?.records
            }
            None => Vec::new(),
        };
        let legacy = read_records_batch(&self.get_records_path_for_key(date_key)).await?;
        let authority: HashMap<&str, &TokenUsageRecord> = attempts
            .iter()
            .filter_map(|record| record_attempt_id(record).map(|id| (id, record)))
            .collect();
        let mut seen = HashSet::new();
        let mut records = Vec::new();
        // Keep the legacy day's append order, substituting canonical facts
        // before filtering or paginating. A stale projection cannot change an
        // attempt's account, session, model or counters in query results.
        for record in legacy.records {
            if let Some(id) = record_attempt_id(&record) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
                records.push(
                    authority
                        .get(id)
                        .map(|record| (*record).clone())
                        .unwrap_or(record),
                );
            } else {
                records.push(record);
            }
        }
        for record in attempts {
            if let Some(id) = record_attempt_id(&record) {
                if !seen.insert(id.to_string()) {
                    continue;
                }
            }
            records.push(record);
        }
        Ok(RecordsBatch { records })
    }

    async fn record_paths_for_range(
        &self,
        time_bounds: Option<(DateTime<Utc>, DateTime<Utc>)>,
    ) -> Result<Vec<PathBuf>, String> {
        let Some((start_date, end_date)) = time_bounds else {
            return self.all_record_paths().await;
        };

        let mut paths = Vec::new();
        let mut current_date = start_date.date_naive();
        let end_date = end_date.date_naive();

        while current_date <= end_date {
            let key = current_date.format("%Y-%m-%d").to_string();
            let path = self.get_records_path_for_key(&key);
            let legacy_exists = fs::try_exists(&path)
                .await
                .map_err(|error| error.to_string())?;
            let attempts_exists = fs::try_exists(self.get_attempts_path_for_key(&key))
                .await
                .map_err(|error| error.to_string())?;
            if legacy_exists || attempts_exists {
                paths.push(path);
            }
            let Some(next_date) = current_date.succ_opt() else {
                break;
            };
            current_date = next_date;
        }

        Ok(paths)
    }

    async fn all_record_paths(&self) -> Result<Vec<PathBuf>, String> {
        let records_dir = self.base_dir.join(RECORDS_DIR);
        let mut paths = BTreeSet::new();
        for directory in [&records_dir, &records_dir.join(MODEL_ATTEMPTS_DIR)] {
            let mut read_dir = match fs::read_dir(directory).await {
                Ok(read_dir) => read_dir,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => {
                    return Err(format!("Failed to read token usage records dir: {}", error));
                }
            };

            while let Some(entry) = read_dir
                .next_entry()
                .await
                .map_err(|e| format!("Failed to read token usage record entry: {}", e))?
            {
                let path = entry.path();
                if is_token_usage_record_path(&path) {
                    // Dates are represented by their legacy path even if only
                    // the authority exists; read_daily_records reads both sources.
                    paths.insert(records_dir.join(entry.file_name()));
                }
            }
        }
        Ok(paths.into_iter().collect())
    }
    pub async fn get_summary(&self, query: TokenUsageQuery) -> Result<TokenUsageSummary, String> {
        let records = self.query_records(query).await?;

        let mut total_input = 0u64;
        let mut total_output = 0u64;
        let mut total_cached = 0u64;
        let mut total_cache_write = 0u64;
        let mut cache_reported_input_tokens = 0u64;
        let mut total_tokens = 0u64;

        let mut by_model: HashMap<String, ModelTokenStats> = HashMap::new();
        let mut by_session: HashMap<String, SessionTokenStats> = HashMap::new();

        for record in &records {
            total_input += record.input_tokens as u64;
            total_output += record.output_tokens as u64;
            total_cached += record.cached_tokens as u64;
            total_cache_write += record.cache_write_tokens as u64;
            if record.cached_tokens_available {
                cache_reported_input_tokens += record.input_tokens as u64;
            }
            total_tokens += record.total_tokens as u64;

            let model_stats = by_model
                .entry(record.effective_model_name.clone())
                .or_insert_with(|| ModelTokenStats {
                    model_id: record.effective_model_name.clone(),
                    ..Default::default()
                });

            model_stats.total_input += record.input_tokens as u64;
            model_stats.total_output += record.output_tokens as u64;
            model_stats.total_cached += record.cached_tokens as u64;
            model_stats.total_cache_write += record.cache_write_tokens as u64;
            if record.cached_tokens_available {
                model_stats.cache_reported_input_tokens += record.input_tokens as u64;
            }
            model_stats.total_tokens += record.total_tokens as u64;
            model_stats.request_count += 1;
            model_stats.session_ids.insert(record.session_id.clone());

            if model_stats.first_used.is_none() || Some(record.timestamp) < model_stats.first_used {
                model_stats.first_used = Some(record.timestamp);
            }
            if model_stats.last_used.is_none() || Some(record.timestamp) > model_stats.last_used {
                model_stats.last_used = Some(record.timestamp);
            }

            let session_stats = by_session
                .entry(record.session_id.clone())
                .or_insert_with(|| SessionTokenStats {
                    session_id: record.session_id.clone(),
                    model_id: record.effective_model_name.clone(),
                    total_input: 0,
                    total_output: 0,
                    total_cached: 0,
                    total_cache_write: 0,
                    cache_reported_input_tokens: 0,
                    total_tokens: 0,
                    request_count: 0,
                    created_at: record.timestamp,
                    last_updated: record.timestamp,
                });

            session_stats.total_input += record.input_tokens;
            session_stats.total_output += record.output_tokens;
            session_stats.total_cached += record.cached_tokens;
            session_stats.total_cache_write += record.cache_write_tokens;
            if record.cached_tokens_available {
                session_stats.cache_reported_input_tokens += record.input_tokens;
            }
            session_stats.total_tokens += record.total_tokens;
            session_stats.request_count += 1;

            if record.timestamp < session_stats.created_at {
                session_stats.created_at = record.timestamp;
            }
            if record.timestamp > session_stats.last_updated {
                session_stats.last_updated = record.timestamp;
            }
        }

        for stats in by_model.values_mut() {
            stats.session_count = stats.session_ids.len() as u32;
        }

        Ok(TokenUsageSummary {
            total_input,
            total_output,
            total_cached,
            total_cache_write,
            cache_reported_input_tokens,
            total_tokens,
            by_model,
            by_session,
            record_count: records.len(),
        })
    }

    pub async fn clear_model_stats(&self, model_id: &str) -> Result<(), String> {
        let _usage_guard = self.usage_lifecycle.write().await;
        let mut model_stats = self.model_stats.write().await;
        model_stats.remove(model_id);
        drop(model_stats);

        self.save_model_stats().await?;

        info!("Cleared statistics for model: {}", model_id);
        Ok(())
    }

    pub async fn clear_all_stats(&self) -> Result<(), String> {
        let _usage_guard = self.usage_lifecycle.write().await;
        let mut model_stats = self.model_stats.write().await;
        model_stats.clear();
        drop(model_stats);

        let mut session_cache = self.session_cache.write().await;
        session_cache.clear();
        drop(session_cache);

        self.save_model_stats().await?;

        let mut record_batches = self.record_batches.lock().await;
        record_batches.clear();

        let records_dir = self.base_dir.join(RECORDS_DIR);
        if records_dir.exists() {
            fs::remove_dir_all(&records_dir)
                .await
                .map_err(|e| format!("Failed to delete records directory: {}", e))?;
            fs::create_dir_all(&records_dir)
                .await
                .map_err(|e| format!("Failed to recreate records directory: {}", e))?;
        }
        drop(record_batches);

        info!("Cleared all token usage statistics");
        Ok(())
    }
}

#[cfg(feature = "token-usage-statistics")]
fn resolve_time_bounds(
    query: &TokenUsageQuery,
    now: DateTime<Utc>,
) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>, String> {
    let time_zone = parse_time_zone(query.time_zone.as_deref())?;
    time_bounds_at(&query.time_range, time_zone, now)
}

#[cfg(not(feature = "token-usage-statistics"))]
fn resolve_time_bounds(
    query: &TokenUsageQuery,
    now: DateTime<Utc>,
) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>, String> {
    if query
        .time_zone
        .as_deref()
        .map(str::trim)
        .is_some_and(|value| !value.is_empty() && !matches!(value, "UTC" | "Etc/UTC" | "Etc/GMT"))
    {
        return Err(
            "IANA token usage time zones require the token-usage-statistics feature".to_string(),
        );
    }

    time_bounds_utc_at(&query.time_range, now)
}

#[cfg(feature = "token-usage-statistics")]
fn time_bounds_at(
    time_range: &TimeRange,
    time_zone: Tz,
    now: DateTime<Utc>,
) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>, String> {
    let local_now = now.with_timezone(&time_zone);
    let start_date =
        match time_range {
            TimeRange::Today => Some(local_now.date_naive()),
            TimeRange::ThisWeek => Some(
                local_now.date_naive()
                    - Duration::days(local_now.weekday().num_days_from_monday() as i64),
            ),
            TimeRange::ThisMonth => Some(local_now.date_naive().with_day(1).ok_or_else(|| {
                "Unable to resolve the first day of the current month".to_string()
            })?),
            TimeRange::All => None,
            TimeRange::Custom { start, end } => {
                if end <= start {
                    return Err("Token usage time range end must be after start".to_string());
                }
                return Ok(Some((*start, *end)));
            }
        };

    start_date
        .map(|date| local_date_start_utc(date, time_zone).map(|start| (start, now)))
        .transpose()
}

#[cfg(not(feature = "token-usage-statistics"))]
fn time_bounds_utc_at(
    time_range: &TimeRange,
    now: DateTime<Utc>,
) -> Result<Option<(DateTime<Utc>, DateTime<Utc>)>, String> {
    let start_date =
        match time_range {
            TimeRange::Today => Some(now.date_naive()),
            TimeRange::ThisWeek => {
                Some(now.date_naive() - Duration::days(now.weekday().num_days_from_monday() as i64))
            }
            TimeRange::ThisMonth => Some(now.date_naive().with_day(1).ok_or_else(|| {
                "Unable to resolve the first day of the current month".to_string()
            })?),
            TimeRange::All => None,
            TimeRange::Custom { start, end } => {
                if end <= start {
                    return Err("Token usage time range end must be after start".to_string());
                }
                return Ok(Some((*start, *end)));
            }
        };

    Ok(start_date.map(|date| {
        let start = date
            .and_hms_opt(0, 0, 0)
            .expect("midnight is valid")
            .and_utc();
        (start, now)
    }))
}

fn records_date_key(date: DateTime<Utc>) -> String {
    date.format("%Y-%m-%d").to_string()
}

fn is_token_usage_record_path(path: &Path) -> bool {
    if path.extension().and_then(|value| value.to_str()) != Some("json") {
        return false;
    }

    path.file_stem()
        .and_then(|value| value.to_str())
        .is_some_and(|stem| NaiveDate::parse_from_str(stem, "%Y-%m-%d").is_ok())
}

fn raw_attempt_id(record: &serde_json::Value) -> Option<&str> {
    record
        .get("token_details")
        .and_then(|details| details.get(super::types::MODEL_REQUEST_CONTEXT_KEY))
        .and_then(|context| context.get("attemptId"))
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
}

fn record_attempt_id(record: &TokenUsageRecord) -> Option<&str> {
    record
        .token_details
        .as_ref()
        .and_then(|details| details.get(super::types::MODEL_REQUEST_CONTEXT_KEY))
        .and_then(|context| context.get("attemptId"))
        .and_then(serde_json::Value::as_str)
        .filter(|id| !id.is_empty())
}

fn validate_attempt_batch(raw: &serde_json::Value) -> Result<(), String> {
    if raw.get("version").and_then(serde_json::Value::as_u64) != Some(1) {
        return Err("Unsupported model usage ledger version; existing data was preserved".into());
    }
    let records = raw
        .get("records")
        .and_then(serde_json::Value::as_array)
        .ok_or_else(|| {
            "Model usage ledger must contain a records array; existing data was preserved"
                .to_string()
        })?;
    let mut seen = HashSet::new();
    for record in records {
        let id = raw_attempt_id(record).ok_or_else(|| "Model usage ledger record is missing its attempt identity; existing data was preserved".to_string())?;
        if !seen.insert(id) {
            return Err(
                "Model usage ledger has duplicate attempt identities; existing data was preserved"
                    .into(),
            );
        }
    }
    Ok(())
}

async fn read_records_batch(path: &Path) -> Result<RecordsBatch, String> {
    crate::json_store::JsonFileStore
        .read_optional(path)
        .await
        .map_err(|error| {
            format!("Failed to read token usage records; existing data was preserved: {error}")
        })
        .map(|batch| {
            batch.unwrap_or(RecordsBatch {
                records: Vec::new(),
            })
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use std::collections::HashSet;

    fn attempt_details(id: &str, known: bool) -> serde_json::Value {
        serde_json::json!({"openbitfunModelRequest":{
            "version":1, "roundId":"round-one", "attemptId":id, "attemptIndex":1,
            "startedAt":"2026-10-13T10:00:00Z", "authentication":"subscription",
            "account":{"provider":"codex", "account_id":"codex", "upstream_account_id":"seat-one"},
            "requestedModel":"wire-model", "outcome":if known {"completed"} else {"failed"}, "usageKnown":known
        }})
    }
    fn all_usage() -> TokenUsageQuery {
        TokenUsageQuery {
            model_id: None,
            session_id: None,
            time_range: TimeRange::All,
            time_zone: None,
            limit: None,
            offset: None,
            include_subagent: true,
        }
    }
    async fn save_attempt(
        service: &TokenUsageService,
        id: &str,
        input: u32,
        known: bool,
    ) -> Result<(), String> {
        service
            .record_usage(
                "model-config".into(),
                "wire-model".into(),
                "session-one".into(),
                "turn-one".into(),
                input,
                if known { 5 } else { 0 },
                known.then_some(2),
                Some(attempt_details(id, known)),
                false,
            )
            .await
    }

    #[tokio::test]
    async fn model_attempts_are_idempotent_across_instances_restart_and_late_replay() {
        let dir = tempfile::tempdir().unwrap();
        let first = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&first, "first", 10, true).await.unwrap();
        let second = TokenUsageService::new(dir.path().into()).await.unwrap();
        let (a, b) = tokio::join!(
            save_attempt(&first, "first", 10, true),
            save_attempt(&second, "first", 10, true)
        );
        a.unwrap();
        b.unwrap();
        assert_eq!(first.query_records(all_usage()).await.unwrap().len(), 1);
        assert_eq!(
            first
                .get_model_stats("wire-model")
                .await
                .unwrap()
                .request_count,
            1
        );
        let (a, b) = tokio::join!(
            save_attempt(&first, "second", 20, true),
            save_attempt(&second, "third", 0, false)
        );
        a.unwrap();
        b.unwrap();
        let restarted = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&restarted, "first", 10, true).await.unwrap();
        let records = restarted.query_records(all_usage()).await.unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(
            records
                .iter()
                .filter(|record| record.usage_is_known())
                .count(),
            2
        );
        assert_eq!(
            records
                .iter()
                .map(|record| record.total_tokens)
                .sum::<u32>(),
            40
        );
        assert!(
            first.get_records_path_for_key("2026-10-13").is_file(),
            "replay uses the frozen request date, not today's date"
        );
    }

    #[tokio::test]
    async fn conflicting_attempt_replay_and_unreadable_batches_preserve_the_existing_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&service, "same", 10, true).await.unwrap();
        let path = service.get_attempts_path_for_key("2026-10-13");
        let before = fs::read(&path).await.unwrap();
        assert!(save_attempt(&service, "same", 11, true)
            .await
            .unwrap_err()
            .contains("Conflicting"));
        assert_eq!(fs::read(&path).await.unwrap(), before);
        assert_eq!(
            service
                .get_model_stats("wire-model")
                .await
                .unwrap()
                .request_count,
            1
        );
        fs::write(&path, b"unreadable-user-data").await.unwrap();
        assert!(save_attempt(&service, "new", 10, true).await.is_err());
        assert_eq!(fs::read(&path).await.unwrap(), b"unreadable-user-data");
        assert!(service.query_records(all_usage()).await.is_err());
    }

    #[tokio::test]
    async fn appending_a_model_attempt_preserves_opaque_legacy_and_future_fields() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&service, "first", 10, true).await.unwrap();
        let path = service.get_attempts_path_for_key("2026-10-13");
        let mut raw: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        raw["futureBatch"] = serde_json::json!({"keep":true});
        raw["records"][0]["futureRecord"] = serde_json::json!([1, 2, 3]);
        raw["records"][0]["token_details"]["futureDetails"] =
            serde_json::json!({"opaque":"retained"});
        fs::write(&path, serde_json::to_vec(&raw).unwrap())
            .await
            .unwrap();
        save_attempt(&service, "second", 20, true).await.unwrap();
        let after: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(after["futureBatch"], raw["futureBatch"]);
        assert_eq!(after["records"][0], raw["records"][0]);
        assert!(save_attempt(&service, "unknown", 1, false).await.is_err());
        assert_eq!(service.query_records(all_usage()).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn cancelling_a_ledger_wait_does_not_abandon_an_accepted_usage_record() {
        let dir = tempfile::tempdir().unwrap();
        let service = Arc::new(TokenUsageService::new(dir.path().into()).await.unwrap());
        let path = service.get_attempts_path_for_key("2026-10-13");
        let guard = crate::json_store::JsonFileStore
            .acquire_cross_process_lock(&path)
            .await
            .unwrap();
        let writer = service.clone();
        let waiter = tokio::spawn(async move { save_attempt(&writer, "accepted", 10, true).await });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !service
                .record_batches
                .lock()
                .await
                .contains_key("model-attempts/2026-10-13")
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        waiter.abort();
        assert!(waiter.await.unwrap_err().is_cancelled());
        drop(guard);
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while service.get_session_stats("session-one").await.is_none() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(service.query_records(all_usage()).await.unwrap().len(), 1);
    }

    #[tokio::test]
    async fn old_cached_daily_overwrite_cannot_remove_native_attempts_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        let path = service.get_records_path_for_key("2026-10-13");
        let mut old_cached_batch = RecordsBatch {
            records: vec![record_at(
                "legacy-before",
                Utc.with_ymd_and_hms(2026, 10, 13, 9, 0, 0).unwrap(),
            )],
        };
        fs::write(&path, serde_json::to_vec(&old_cached_batch).unwrap())
            .await
            .unwrap();
        save_attempt(&service, "native", 10, true).await.unwrap();

        // The old service retains this batch in memory and rewrites it without
        // consulting a JSON lock or seeing the newly appended native attempt.
        old_cached_batch.records.push(record_at(
            "legacy-after",
            Utc.with_ymd_and_hms(2026, 10, 13, 11, 0, 0).unwrap(),
        ));
        fs::write(&path, serde_json::to_vec(&old_cached_batch).unwrap())
            .await
            .unwrap();
        let restarted = TokenUsageService::new(dir.path().into()).await.unwrap();
        let records = restarted.query_records(all_usage()).await.unwrap();
        assert_eq!(records.len(), 3);
        assert_eq!(
            records
                .iter()
                .filter(|record| record.request_context().is_some())
                .count(),
            1
        );
        assert_eq!(records[2].request_context().unwrap().attempt_id, "native");
        assert_eq!(records[2].total_tokens, 15);

        // Redelivery repairs the old-reader projection without duplicating
        // authority, query results or the cached aggregate.
        let count_before = restarted
            .get_model_stats("wire-model")
            .await
            .unwrap()
            .request_count;
        save_attempt(&restarted, "native", 10, true).await.unwrap();
        assert_eq!(read_records_batch(&path).await.unwrap().records.len(), 3);
        assert_eq!(restarted.query_records(all_usage()).await.unwrap().len(), 3);
        assert_eq!(
            restarted
                .get_model_stats("wire-model")
                .await
                .unwrap()
                .request_count,
            count_before
        );
    }

    #[tokio::test]
    async fn authority_precedes_stale_projections_before_scope_filters_and_pagination() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&service, "first", 10, true).await.unwrap();
        save_attempt(&service, "second", 20, true).await.unwrap();
        let path = service.get_records_path_for_key("2026-10-13");
        let mut batch = read_records_batch(&path).await.unwrap();
        batch.records[0].session_id = "wrong-session".into();
        batch.records[0].effective_model_name = "wrong-model".into();
        batch.records[0].input_tokens = 999;
        batch.records[0].is_subagent = true;
        batch.records[0].token_details.as_mut().unwrap()["openbitfunModelRequest"]["account"]
            ["account_id"] = serde_json::json!("wrong-account");
        batch.records.insert(1, batch.records[0].clone());
        fs::write(&path, serde_json::to_vec(&batch).unwrap())
            .await
            .unwrap();
        let records = service.query_records(all_usage()).await.unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[0].input_tokens, 10);
        assert_eq!(
            records[0]
                .request_context()
                .unwrap()
                .account
                .unwrap()
                .account_id,
            "codex"
        );
        let mut query = all_usage();
        query.session_id = Some("wrong-session".into());
        assert!(service.query_records(query).await.unwrap().is_empty());
        let mut query = all_usage();
        query.model_id = Some("wrong-model".into());
        assert!(service.query_records(query).await.unwrap().is_empty());
        let mut query = all_usage();
        query.model_id = Some("wire-model".into());
        query.include_subagent = false;
        query.offset = Some(1);
        query.limit = Some(1);
        let scoped = service
            .query_records_for_sessions(query, &HashSet::from(["session-one".into()]))
            .await
            .unwrap();
        assert_eq!(scoped.len(), 1);
        assert_eq!(scoped[0].request_context().unwrap().attempt_id, "second");
    }

    #[tokio::test]
    async fn authority_only_dates_are_queryable_without_creating_or_repairing_files() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&service, "only-authority", 10, true)
            .await
            .unwrap();
        let projection = service.get_records_path_for_key("2026-10-13");
        fs::remove_file(&projection).await.unwrap();
        let reader = TokenUsageService::for_queries(dir.path().into());
        assert_eq!(reader.query_records(all_usage()).await.unwrap().len(), 1);
        let mut query = all_usage();
        query.time_range = TimeRange::Custom {
            start: Utc.with_ymd_and_hms(2026, 10, 13, 10, 0, 0).unwrap(),
            end: Utc.with_ymd_and_hms(2026, 10, 13, 11, 0, 0).unwrap(),
        };
        assert_eq!(reader.query_records(query.clone()).await.unwrap().len(), 1);
        query.time_range = TimeRange::Custom {
            start: Utc.with_ymd_and_hms(2026, 10, 13, 11, 0, 0).unwrap(),
            end: Utc.with_ymd_and_hms(2026, 10, 14, 0, 0, 0).unwrap(),
        };
        assert!(reader.query_records(query).await.unwrap().is_empty());
        assert!(
            !projection.exists(),
            "readers cannot repair or create projections"
        );
        let missing_dir = dir.path().join("missing");
        let empty = TokenUsageService::for_queries(missing_dir.clone());
        assert!(empty.query_records(all_usage()).await.unwrap().is_empty());
        assert!(!missing_dir.exists());
        service.clear_all_stats().await.unwrap();
        assert!(!service.get_attempts_path_for_key("2026-10-13").exists());
        assert!(reader.query_records(all_usage()).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn pre_authority_native_rows_are_promoted_without_losing_unknown_fields() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&service, "earlier", 10, true).await.unwrap();
        let path = service.get_records_path_for_key("2026-10-13");
        let authority = service.get_attempts_path_for_key("2026-10-13");
        fs::remove_file(&authority).await.unwrap();
        let mut raw: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        raw["futureBatch"] = serde_json::json!({"keep":true});
        raw["records"][0]["futureRecord"] = serde_json::json!({"keep":"opaque"});
        fs::write(&path, serde_json::to_vec(&raw).unwrap())
            .await
            .unwrap();
        save_attempt(&service, "later", 20, true).await.unwrap();
        let canonical: serde_json::Value =
            serde_json::from_slice(&fs::read(&authority).await.unwrap()).unwrap();
        assert_eq!(canonical["version"], 1);
        assert_eq!(canonical["records"][0], raw["records"][0]);
        let projected: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(projected["futureBatch"], raw["futureBatch"]);
        assert_eq!(projected["records"][0], raw["records"][0]);
        fs::write(&path, b"{\"records\":[]}").await.unwrap();
        let reader = TokenUsageService::for_queries(dir.path().into());
        assert_eq!(reader.query_records(all_usage()).await.unwrap().len(), 2);
    }

    #[tokio::test]
    async fn failed_projection_preserves_authority_and_redelivery_repairs_the_projection() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        let projection = service.get_records_path_for_key("2026-10-13");
        fs::write(&projection, b"unreadable-user-data")
            .await
            .unwrap();
        save_attempt(&service, "accepted", 10, true).await.unwrap();
        assert_eq!(
            read_records_batch(&service.get_attempts_path_for_key("2026-10-13"))
                .await
                .unwrap()
                .records
                .len(),
            1
        );
        assert_eq!(
            fs::read(&projection).await.unwrap(),
            b"unreadable-user-data"
        );
        assert!(
            service.query_records(all_usage()).await.is_err(),
            "unreadable legacy data must still be surfaced"
        );
        // Only the fixture repairs the corrupt data. The service never resets it.
        fs::write(&projection, b"{\"records\":[]}").await.unwrap();
        save_attempt(&service, "accepted", 10, true).await.unwrap();
        assert_eq!(
            read_records_batch(&projection).await.unwrap().records.len(),
            1
        );
        assert_eq!(service.query_records(all_usage()).await.unwrap().len(), 1);
        assert_eq!(
            service
                .get_model_stats("wire-model")
                .await
                .unwrap()
                .request_count,
            1
        );
    }

    #[tokio::test]
    async fn unsupported_or_invalid_authority_never_falls_back_to_the_projection() {
        let dir = tempfile::tempdir().unwrap();
        let service = TokenUsageService::new(dir.path().into()).await.unwrap();
        save_attempt(&service, "first", 10, true).await.unwrap();
        let path = service.get_attempts_path_for_key("2026-10-13");
        let raw: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).await.unwrap()).unwrap();
        let mut future = raw.clone();
        future["version"] = serde_json::json!(99);
        let mut duplicate = raw.clone();
        duplicate["records"]
            .as_array_mut()
            .unwrap()
            .push(raw["records"][0].clone());
        let mut no_id = raw.clone();
        no_id["records"][0]["token_details"]["openbitfunModelRequest"]["attemptId"] =
            serde_json::json!("");
        for invalid in [future, duplicate, no_id] {
            let bytes = serde_json::to_vec(&invalid).unwrap();
            fs::write(&path, &bytes).await.unwrap();
            let reader = TokenUsageService::for_queries(dir.path().into());
            assert!(reader.query_records(all_usage()).await.is_err());
            assert!(save_attempt(&service, "second", 20, true).await.is_err());
            assert_eq!(fs::read(&path).await.unwrap(), bytes);
            assert_eq!(
                read_records_batch(&service.get_records_path_for_key("2026-10-13"))
                    .await
                    .unwrap()
                    .records
                    .len(),
                1
            );
        }
    }

    #[tokio::test]
    async fn query_records_for_sessions_filters_before_returning_records() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = TokenUsageService::new(dir.path().to_path_buf())
            .await
            .expect("token usage service");
        service
            .record_usage(
                "model-config-a".to_string(),
                "model-a".to_string(),
                "parent-session".to_string(),
                "parent-turn".to_string(),
                10,
                2,
                None,
                None,
                false,
            )
            .await
            .expect("parent record");
        service
            .record_usage(
                "model-config-b".to_string(),
                "model-b".to_string(),
                "unrelated-session".to_string(),
                "unrelated-turn".to_string(),
                20,
                4,
                None,
                None,
                false,
            )
            .await
            .expect("unrelated record");

        // A separate short-lived query process has no runtime subscriber or
        // in-memory usage cache. Aggregate corruption must not trigger repair.
        let stats_path = dir.path().join(MODEL_STATS_FILE);
        std::fs::write(&stats_path, "unreadable legacy aggregate").unwrap();
        let reader = TokenUsageService::for_queries(dir.path().to_path_buf());
        let records = reader
            .query_records_for_sessions(
                TokenUsageQuery {
                    model_id: None,
                    session_id: None,
                    time_range: TimeRange::All,
                    time_zone: None,
                    limit: None,
                    offset: None,
                    include_subagent: true,
                },
                &HashSet::from(["parent-session".to_string()]),
            )
            .await
            .expect("scoped records");

        assert_eq!(records.len(), 1);
        assert_eq!(records[0].session_id, "parent-session");
        assert_eq!(
            std::fs::read_to_string(&stats_path).unwrap(),
            "unreadable legacy aggregate"
        );
        assert!(!stats_path.with_extension("json.bak").exists());
    }

    #[cfg(feature = "token-usage-statistics")]
    #[test]
    fn today_uses_the_requested_local_calendar() {
        let now = Utc.with_ymd_and_hms(2026, 8, 16, 1, 30, 0).unwrap();
        let bounds = time_bounds_at(&TimeRange::Today, chrono_tz::Asia::Shanghai, now)
            .expect("today bounds")
            .expect("bounded range");

        assert_eq!(
            bounds.0,
            Utc.with_ymd_and_hms(2026, 8, 15, 16, 0, 0).unwrap()
        );
        assert_eq!(bounds.1, now);
    }

    #[cfg(not(feature = "token-usage-statistics"))]
    #[test]
    fn local_storage_only_keeps_utc_calendar_ranges() {
        let now = Utc.with_ymd_and_hms(2026, 8, 16, 1, 30, 0).unwrap();
        let bounds = time_bounds_utc_at(&TimeRange::Today, now)
            .expect("today bounds")
            .expect("bounded range");

        assert_eq!(
            bounds.0,
            Utc.with_ymd_and_hms(2026, 8, 16, 0, 0, 0).unwrap()
        );
        assert_eq!(bounds.1, now);
    }

    #[tokio::test]
    async fn query_records_filters_boundary_day_records_by_timestamp() {
        let dir = tempfile::tempdir().expect("temp dir");
        let service = TokenUsageService::new(dir.path().to_path_buf())
            .await
            .expect("token usage service");
        let start = Utc.with_ymd_and_hms(2026, 8, 16, 10, 0, 0).unwrap();
        let end = Utc.with_ymd_and_hms(2026, 8, 17, 10, 0, 0).unwrap();

        for (date, records) in [
            (
                "2026-08-16",
                vec![
                    record_at("before", start - Duration::seconds(1)),
                    record_at("start", start),
                ],
            ),
            (
                "2026-08-17",
                vec![
                    record_at("inside", end - Duration::seconds(1)),
                    record_at("end", end),
                ],
            ),
        ] {
            let path = service.get_records_path_for_key(date);
            fs::write(
                path,
                serde_json::to_string(&RecordsBatch { records }).expect("serialize batch"),
            )
            .await
            .expect("write record batch");
        }

        let records = service
            .query_records(TokenUsageQuery {
                model_id: None,
                session_id: None,
                time_range: TimeRange::Custom { start, end },
                time_zone: None,
                limit: None,
                offset: None,
                include_subagent: true,
            })
            .await
            .expect("query records");

        assert_eq!(
            records
                .iter()
                .map(|record| record.turn_id.as_str())
                .collect::<Vec<_>>(),
            vec!["start", "inside"]
        );
    }

    fn record_at(turn_id: &str, timestamp: DateTime<Utc>) -> TokenUsageRecord {
        TokenUsageRecord {
            model_config_id: "config".to_string(),
            effective_model_name: "model".to_string(),
            session_id: "session".to_string(),
            turn_id: turn_id.to_string(),
            timestamp,
            input_tokens: 1,
            output_tokens: 1,
            cached_tokens: 0,
            cached_tokens_available: false,
            cache_write_tokens: 0,
            total_tokens: 2,
            token_details: None,
            is_subagent: false,
        }
    }
}
