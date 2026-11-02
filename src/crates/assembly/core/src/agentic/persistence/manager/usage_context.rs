use super::PersistenceManager;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_core_types::UsageContextCategory;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

/// Latest prepared request only. Kept separately from numeric usage records and exports.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionUsageContextSnapshot {
    pub schema_version: u16,
    pub session_id: String,
    pub turn_id: String,
    pub turn_index: usize,
    pub captured_at: u64,
    #[serde(default)]
    pub contents: BTreeMap<UsageContextCategory, String>,
}

impl PersistenceManager {
    pub(crate) async fn save_usage_context_snapshot(
        &self,
        storage_path: &Path,
        snapshot: &SessionUsageContextSnapshot,
    ) -> OpenBitFunResult<()> {
        Self::validate_session_id(&snapshot.session_id)?;
        let _session_write =
            self.lock_session_write_operation(storage_path, &snapshot.session_id)?;
        self.ensure_runtime_for_write(storage_path).await?;
        self.ensure_session_dir(storage_path, &snapshot.session_id)
            .await?;
        self.write_json_atomic(
            &self
                .session_layout(storage_path)
                .session_dir(&snapshot.session_id)
                .join("usage-context.json"),
            snapshot,
        )
        .await
    }

    pub(crate) async fn load_usage_context_snapshot(
        &self,
        storage_path: &Path,
        session_id: &str,
    ) -> OpenBitFunResult<Option<SessionUsageContextSnapshot>> {
        Self::validate_session_id(session_id)?;
        let snapshot = self
            .read_json_optional::<SessionUsageContextSnapshot>(
                &self
                    .session_layout(storage_path)
                    .session_dir(session_id)
                    .join("usage-context.json"),
            )
            .await?;
        if snapshot.as_ref().is_some_and(|snapshot| {
            snapshot.session_id != session_id || snapshot.schema_version != 1
        }) {
            return Err(OpenBitFunError::validation(
                "Unsupported or mismatched usage context snapshot",
            ));
        }
        Ok(snapshot)
    }
}
