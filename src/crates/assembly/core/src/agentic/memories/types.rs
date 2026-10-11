use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemorySourceSession {
    pub workspace_path: String,
    pub rollout_path: String,
    pub session_id: String,
    pub session_name: String,
    pub agent_type: String,
    pub turn_count: usize,
    pub last_finished_unix_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryExtractionRecord {
    pub source: MemorySourceSession,
    pub raw_memory: String,
    pub rollout_summary: String,
    pub rollout_slug: Option<String>,
    pub created_at_unix_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct MemoryPhase1RunStats {
    pub scanned_sessions: usize,
    pub candidate_sessions: usize,
    pub extracted_sessions: usize,
    pub skipped_sessions: usize,
    pub failed_sessions: usize,
    /// Skips caused by an unresolvable workspace session storage root.
    ///
    /// The session storage directory is owned by the workspace identity, so a
    /// workspace that does not resolve to a local or registered remote workspace
    /// has no persisted turns to read. That is a different cause from "already
    /// captured" or "another job owns it", so it is reported as its own fact
    /// instead of being folded into `skipped_sessions`. Additive with a serde
    /// default so an older reader of this shape keeps working.
    #[serde(default)]
    pub storage_unavailable_sessions: u64,
}

#[cfg(test)]
mod tests {
    use super::MemoryPhase1RunStats;

    #[test]
    fn phase1_run_stats_default_is_all_zeroes() {
        assert_eq!(
            MemoryPhase1RunStats::default(),
            MemoryPhase1RunStats {
                scanned_sessions: 0,
                candidate_sessions: 0,
                extracted_sessions: 0,
                skipped_sessions: 0,
                failed_sessions: 0,
                storage_unavailable_sessions: 0,
            }
        );
    }

    #[test]
    fn phase1_run_stats_deserialize_without_the_storage_unavailable_field() {
        // Shape written before the typed storage-unavailable signal existed.
        let stats: MemoryPhase1RunStats = serde_json::from_str(
            r#"{"scanned_sessions":1,"candidate_sessions":1,"extracted_sessions":0,"skipped_sessions":1,"failed_sessions":0}"#,
        )
        .unwrap();
        assert_eq!(stats.skipped_sessions, 1);
        assert_eq!(stats.storage_unavailable_sessions, 0);
    }
}
