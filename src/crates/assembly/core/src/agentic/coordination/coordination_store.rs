use crate::service::coordination_persistence::{
    initialize_coordination_schema, validate_coordination_agent_id,
};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use openbitfun_core_types::agent_identity::{canonical_agent_id, HarnessId};
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::OnceCell;
use tokio::task;
use uuid::Uuid;

const SWARM_MAX_NODES: i64 = 128;
const SWARM_MAX_DEPTH: i64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BackgroundTaskStatus {
    Running,
    Completed,
    PartialTimeout,
    Failed,
    Cancelled,
    Interrupted,
}

impl BackgroundTaskStatus {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Completed => "completed",
            Self::PartialTimeout => "partial_timeout",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
            Self::Interrupted => "interrupted",
        }
    }

    pub(crate) fn is_terminal(self) -> bool {
        self != Self::Running
    }

    fn parse(value: &str) -> OpenBitFunResult<Self> {
        match value {
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "partial_timeout" => Ok(Self::PartialTimeout),
            "failed" => Ok(Self::Failed),
            "cancelled" => Ok(Self::Cancelled),
            "interrupted" => Ok(Self::Interrupted),
            _ => Err(OpenBitFunError::service(format!(
                "Invalid background task status in coordination database: {value}"
            ))),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct BackgroundTaskRegistration {
    pub parent_session_id: String,
    pub requested_agent_id: Option<String>,
    pub child_session_id: String,
    pub parent_dialog_turn_id: String,
    pub parent_tool_call_id: String,
    pub child_dialog_turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegisteredBackgroundTask {
    pub task_pk: i64,
    pub agent_id: String,
    pub bg_task_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct BackgroundTaskRecord {
    pub task_pk: i64,
    pub parent_session_id: String,
    pub agent_id: String,
    pub bg_task_id: String,
    pub child_session_id: String,
    pub parent_dialog_turn_id: String,
    pub parent_tool_call_id: String,
    pub child_dialog_turn_id: String,
    pub status: BackgroundTaskStatus,
    pub error_code: Option<String>,
    pub error_message: Option<String>,
    pub execution_owner_token: String,
    pub delivered_at_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DirectChildAgentRecord {
    pub agent_id: String,
    pub child_session_id: String,
    pub status: BackgroundTaskStatus,
    pub background_turn_id: Option<String>,
}

pub(crate) struct CoordinationStore {
    db_path: PathBuf,
    connection: OnceCell<Arc<Mutex<Connection>>>,
    execution_owner_token: String,
}

impl CoordinationStore {
    pub(crate) fn new(db_path: PathBuf) -> Self {
        Self {
            db_path,
            connection: OnceCell::new(),
            execution_owner_token: Uuid::new_v4().to_string(),
        }
    }

    async fn connection(&self) -> OpenBitFunResult<Arc<Mutex<Connection>>> {
        let db_path = self.db_path.clone();
        self.connection
            .get_or_try_init(|| async move {
                task::spawn_blocking(move || open_connection(db_path))
                    .await
                    .map_err(|error| {
                        OpenBitFunError::service(format!(
                            "Agent coordination database initialization task failed: {error}"
                        ))
                    })?
            })
            .await
            .cloned()
    }

    async fn with_connection<T, F>(&self, operation: F) -> OpenBitFunResult<T>
    where
        T: Send + 'static,
        F: FnOnce(&mut Connection) -> OpenBitFunResult<T> + Send + 'static,
    {
        let connection = self.connection().await?;
        task::spawn_blocking(move || {
            let mut connection = connection.lock().map_err(|_| {
                OpenBitFunError::service(
                    "Agent coordination database lock was poisoned".to_string(),
                )
            })?;
            operation(&mut connection)
        })
        .await
        .map_err(|error| {
            OpenBitFunError::service(format!("Agent coordination database task failed: {error}"))
        })?
    }

    pub(crate) async fn agent_id_for_session_with_requested_id(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        requested_agent_id: Option<&str>,
    ) -> OpenBitFunResult<String> {
        let parent_session_id = parent_session_id.to_string();
        let child_session_id = child_session_id.to_string();
        let requested_agent_id = requested_agent_id.map(str::to_string);
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let (_, agent_id) = get_or_create_agent(
                &transaction,
                &parent_session_id,
                &child_session_id,
                requested_agent_id.as_deref(),
            )?;
            transaction.commit().map_err(db_error)?;
            Ok(agent_id)
        })
        .await
    }

    pub(crate) async fn existing_agent_id_for_session(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
    ) -> OpenBitFunResult<Option<String>> {
        let parent_session_id = parent_session_id.to_string();
        let child_session_id = child_session_id.to_string();
        self.with_connection(move |connection| {
            connection
                .query_row(
                    "SELECT agent_id FROM agents WHERE parent_session_id = ?1 AND child_session_id = ?2",
                    params![parent_session_id, child_session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(db_error)
        })
        .await
    }

    pub(crate) async fn resolve_agent_id(
        &self,
        parent_session_id: &str,
        agent_id: &str,
    ) -> OpenBitFunResult<String> {
        let parent_session_id = parent_session_id.to_string();
        let agent_id = agent_id.to_string();
        self.with_connection(move |connection| {
            connection
                .query_row(
                    "SELECT child_session_id FROM agents WHERE parent_session_id = ?1 AND agent_id = ?2 AND state = 'active'",
                    params![parent_session_id, agent_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(db_error)?
                .flatten()
                .ok_or_else(|| OpenBitFunError::tool(format!("Agent was not found: {agent_id}")))
        })
        .await
    }

    pub(crate) async fn direct_child_agents(
        &self,
        parent_session_id: &str,
    ) -> OpenBitFunResult<Vec<DirectChildAgentRecord>> {
        let parent_session_id = parent_session_id.to_string();
        self.with_connection(move |connection| {
            // Foreground Task registers its agent after completion. Live Session
            // state and later user-turn summaries are projected by the caller.
            let mut statement = connection
                .prepare(
                    r#"
WITH latest_tasks AS (
    SELECT agent_pk, status, child_dialog_turn_id,
           ROW_NUMBER() OVER (PARTITION BY agent_pk ORDER BY task_pk DESC) AS row_number
    FROM background_tasks
)
SELECT agents.agent_id, agents.child_session_id,
       COALESCE(latest_tasks.status, 'completed'), latest_tasks.child_dialog_turn_id
FROM agents
LEFT JOIN latest_tasks
  ON latest_tasks.agent_pk = agents.agent_pk
 AND latest_tasks.row_number = 1
WHERE agents.parent_session_id = ?1
  AND agents.state = 'active'
  AND agents.child_session_id IS NOT NULL
ORDER BY agents.created_at_ms ASC, agents.agent_pk ASC
                    "#,
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![parent_session_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                    ))
                })
                .map_err(db_error)?;
            rows.map(|row| {
                let (agent_id, child_session_id, status, background_turn_id) =
                    row.map_err(db_error)?;
                Ok(DirectChildAgentRecord {
                    agent_id,
                    child_session_id,
                    status: BackgroundTaskStatus::parse(&status)?,
                    background_turn_id,
                })
            })
            .collect()
        })
        .await
    }

    pub(crate) async fn reserved_agent_ids(
        &self,
        parent_session_id: &str,
    ) -> OpenBitFunResult<Vec<String>> {
        let parent_session_id = parent_session_id.to_string();
        self.with_connection(move |connection| {
            let mut statement = connection.prepare(
                "SELECT agent_id FROM agents WHERE parent_session_id = ?1 AND state = 'historical' ORDER BY created_at_ms ASC, agent_pk ASC",
            ).map_err(db_error)?;
            let rows = statement.query_map(params![parent_session_id], |row| row.get::<_, String>(0))
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
        }).await
    }

    pub(crate) async fn resolve_direct_child_agent_id(
        &self,
        parent_session_id: &str,
        agent_id: &str,
    ) -> OpenBitFunResult<String> {
        let parent_session_id = parent_session_id.to_string();
        let agent_id = agent_id.to_string();
        self.with_connection(move |connection| {
            connection
                .query_row(
                    "SELECT child_session_id FROM agents WHERE parent_session_id = ?1 AND agent_id = ?2 AND state = 'active' AND child_session_id IS NOT NULL",
                    params![parent_session_id, agent_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(db_error)?
                .ok_or_else(|| OpenBitFunError::tool(format!("Direct child agent was not found: {agent_id}")))
        })
        .await
    }

    pub(crate) async fn reserve_swarm_child(
        &self,
        parent_session_id: &str,
        child_session_id: &str,
        parent_agent_type: &str,
        child_agent_type: &str,
        child_depth: u8,
    ) -> OpenBitFunResult<()> {
        let parent_session_id = parent_session_id.to_string();
        let child_session_id = child_session_id.to_string();
        let parent_agent_type = parent_agent_type.to_string();
        let child_agent_type = child_agent_type.to_string();
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            if !matches!(
                child_agent_type.as_str(),
                "SwarmPlanner" | "SwarmWorker" | "SwarmReviewer"
            ) {
                return Err(OpenBitFunError::tool(format!(
                    "Swarm cannot launch agent_type={child_agent_type}"
                )));
            }
            let child_depth = i64::from(child_depth);
            if child_depth == 0 || child_depth > SWARM_MAX_DEPTH {
                return Err(OpenBitFunError::tool(format!(
                    "Swarm tree height limit exceeded: child depth {child_depth}, maximum {SWARM_MAX_DEPTH}"
                )));
            }
            if child_depth == SWARM_MAX_DEPTH && child_agent_type == "SwarmPlanner" {
                return Err(OpenBitFunError::tool(
                    "SwarmPlanner cannot be launched at the final tree level".to_string(),
                ));
            }

            let root_session_id = transaction
                .query_row(
                    "SELECT root_session_id FROM swarm_nodes WHERE session_id = ?1",
                    params![parent_session_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(db_error)?;
            let root_session_id = match root_session_id {
                Some(root_session_id) => root_session_id,
                None if parent_agent_type == "Ultimate" => parent_session_id.clone(),
                None => {
                    return Err(OpenBitFunError::tool(
                        "Swarm parent is not part of the current tree".to_string(),
                    ));
                }
            };
            transaction
                .execute(
                    "INSERT OR IGNORE INTO swarm_trees (root_session_id, created_at_ms) VALUES (?1, ?2)",
                    params![root_session_id, unix_time_ms() as i64],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "INSERT OR IGNORE INTO swarm_nodes (session_id, root_session_id, parent_session_id, agent_type, depth, created_at_ms) VALUES (?1, ?1, NULL, ?2, 0, ?3)",
                    params![root_session_id, HarnessId::Ultimate.as_str(), unix_time_ms() as i64],
                )
                .map_err(db_error)?;

            let parent = transaction
                .query_row(
                    "SELECT root_session_id, depth, agent_type FROM swarm_nodes WHERE session_id = ?1",
                    params![parent_session_id],
                    |row| {
                        let agent_type = row.get::<_, String>(2)?;
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            canonical_agent_id(&agent_type).to_owned(),
                        ))
                    },
                )
                .optional()
                .map_err(db_error)?
                .ok_or_else(|| OpenBitFunError::tool("Swarm parent is not part of the current tree".to_string()))?;
            if parent.2 != parent_agent_type {
                return Err(OpenBitFunError::tool(
                    "Swarm parent agent type does not match its persisted tree node".to_string(),
                ));
            }
            if parent.0 != root_session_id || parent.1.saturating_add(1) != child_depth {
                return Err(OpenBitFunError::tool(
                    "Swarm child depth does not match its parent lineage".to_string(),
                ));
            }
            if !matches!(parent.2.as_str(), "Ultimate" | "SwarmPlanner") {
                return Err(OpenBitFunError::tool(
                    "Only a Swarm planner can launch child agents".to_string(),
                ));
            }
            let node_count = transaction
                .query_row(
                    "SELECT COUNT(*) FROM swarm_nodes WHERE root_session_id = ?1",
                    params![root_session_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(db_error)?;
            if node_count >= SWARM_MAX_NODES {
                return Err(OpenBitFunError::tool(format!(
                    "Swarm tree size limit reached: maximum {SWARM_MAX_NODES} agents including the root"
                )));
            }
            transaction
                .execute(
                    "INSERT INTO swarm_nodes (session_id, root_session_id, parent_session_id, agent_type, depth, created_at_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    params![child_session_id, root_session_id, parent_session_id, child_agent_type, child_depth, unix_time_ms() as i64],
                )
                .map_err(|error| OpenBitFunError::tool(format!("Failed to reserve Swarm node: {error}")))?;
            transaction.commit().map_err(db_error)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn rollback_swarm_child(
        &self,
        child_session_id: &str,
    ) -> OpenBitFunResult<()> {
        let child_session_id = child_session_id.to_string();
        self.with_connection(move |connection| {
            connection
                .execute(
                    "DELETE FROM swarm_nodes WHERE session_id = ?1 AND parent_session_id IS NOT NULL",
                    params![child_session_id],
                )
                .map_err(db_error)?;
            Ok(())
        })
        .await
    }

    pub(crate) async fn swarm_depth_for_session(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<Option<u8>> {
        let session_id = session_id.to_string();
        self.with_connection(move |connection| {
            connection
                .query_row(
                    "SELECT depth FROM swarm_nodes WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(db_error)
                .map(|depth| depth.and_then(|value| u8::try_from(value).ok()))
        })
        .await
    }

    pub(crate) async fn agent_subtree_session_ids_postorder(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<String>> {
        let session_id = session_id.to_string();
        self.with_connection(move |connection| {
            // Ordinary agents use the agent registry; include Swarm reservations
            // as well so nodes awaiting task registration remain in the subtree.
            let mut statement = connection
                .prepare(
                    r#"
WITH RECURSIVE lineage(parent_session_id, session_id) AS (
    SELECT parent_session_id, child_session_id FROM agents
    WHERE state = 'active' AND child_session_id IS NOT NULL
    UNION
    SELECT parent_session_id, session_id FROM swarm_nodes
), subtree(session_id, depth) AS (
    SELECT DISTINCT session_id, 0 FROM lineage WHERE session_id = ?1
    UNION ALL
    SELECT child.session_id, parent.depth + 1
    FROM lineage child
    JOIN subtree parent ON child.parent_session_id = parent.session_id
)
SELECT session_id FROM subtree ORDER BY depth DESC, session_id ASC
                    "#,
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(params![session_id], |row| row.get::<_, String>(0))
                .map_err(db_error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
        })
        .await
    }

    pub(crate) async fn register_background_task(
        &self,
        registration: BackgroundTaskRegistration,
    ) -> OpenBitFunResult<RegisteredBackgroundTask> {
        let execution_owner_token = self.execution_owner_token.clone();
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let (agent_pk, agent_id) = get_or_create_agent(
                &transaction,
                &registration.parent_session_id,
                &registration.child_session_id,
                registration.requested_agent_id.as_deref(),
            )?;
            let next_bg_seq = transaction
                .query_row(
                    "SELECT next_bg_seq FROM agents WHERE agent_pk = ?1",
                    params![agent_pk],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(db_error)?;
            let bg_task_id = format!("{agent_id}_bg{next_bg_seq}");
            transaction
                .execute(
                    "UPDATE agents SET next_bg_seq = ?1 WHERE agent_pk = ?2",
                    params![next_bg_seq.saturating_add(1), agent_pk],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    r#"
INSERT INTO background_tasks (
    parent_session_id, agent_pk, bg_task_id, bg_ordinal,
    parent_dialog_turn_id, parent_tool_call_id, child_dialog_turn_id,
    status, execution_owner_token, created_at_ms
) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'running', ?8, ?9)
                    "#,
                    params![
                        registration.parent_session_id,
                        agent_pk,
                        bg_task_id,
                        next_bg_seq,
                        registration.parent_dialog_turn_id,
                        registration.parent_tool_call_id,
                        registration.child_dialog_turn_id,
                        execution_owner_token,
                        unix_time_ms() as i64,
                    ],
                )
                .map_err(db_error)?;
            let task_pk = transaction.last_insert_rowid();
            transaction.commit().map_err(db_error)?;
            Ok(RegisteredBackgroundTask {
                task_pk,
                agent_id,
                bg_task_id,
            })
        })
        .await
    }

    pub(crate) async fn update_task_status(
        &self,
        task_pk: i64,
        status: BackgroundTaskStatus,
        error_code: Option<String>,
        error_message: Option<String>,
    ) -> OpenBitFunResult<bool> {
        self.with_connection(move |connection| {
            let changed = connection
                .execute(
                    r#"
UPDATE background_tasks
SET status = ?1, error_code = ?2, error_message = ?3, terminal_at_ms = ?4
WHERE task_pk = ?5 AND status = 'running'
                    "#,
                    params![
                        status.as_str(),
                        error_code,
                        error_message,
                        status.is_terminal().then(|| unix_time_ms() as i64),
                        task_pk,
                    ],
                )
                .map_err(db_error)?;
            Ok(changed > 0)
        })
        .await
    }

    pub(crate) async fn discard_unsubmitted_background_task(
        &self,
        task_pk: i64,
        release_agent_reservation: bool,
    ) -> OpenBitFunResult<bool> {
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let agent_pk = transaction
                .query_row(
                    "SELECT agent_pk FROM background_tasks WHERE task_pk = ?1",
                    params![task_pk],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM background_tasks WHERE task_pk = ?1",
                    params![task_pk],
                )
                .map_err(db_error)?;
            let released_agent_reservation =
                if let (true, Some(agent_pk)) = (release_agent_reservation, agent_pk) {
                    transaction
                    .execute(
                        "DELETE FROM agents WHERE agent_pk = ?1 AND NOT EXISTS (SELECT 1 FROM background_tasks WHERE agent_pk = ?1)",
                        params![agent_pk],
                    )
                    .map_err(db_error)?
                        > 0
                } else {
                    false
                };
            transaction.commit().map_err(db_error)?;
            Ok(released_agent_reservation)
        })
        .await
    }

    pub(crate) async fn wait_candidates(
        &self,
        parent_session_id: &str,
        requested_bg_task_ids: &[String],
    ) -> OpenBitFunResult<Vec<BackgroundTaskRecord>> {
        let parent_session_id = parent_session_id.to_string();
        let requested_bg_task_ids = requested_bg_task_ids.to_vec();
        self.with_connection(move |connection| {
            if requested_bg_task_ids.is_empty() {
                let mut statement = connection
                    .prepare(&format!(
                        "{} WHERE tasks.parent_session_id = ?1 AND tasks.delivered_at_ms IS NULL ORDER BY tasks.task_pk",
                        BACKGROUND_TASK_SELECT
                    ))
                    .map_err(db_error)?;
                let rows = statement
                    .query_map(params![parent_session_id], background_task_from_row)
                    .map_err(db_error)?;
                return collect_rows(rows);
            }

            let mut records = Vec::with_capacity(requested_bg_task_ids.len());
            for bg_task_id in requested_bg_task_ids {
                let record = connection
                    .query_row(
                        &format!(
                            "{} WHERE tasks.parent_session_id = ?1 AND tasks.bg_task_id = ?2",
                            BACKGROUND_TASK_SELECT
                        ),
                        params![parent_session_id, bg_task_id],
                        background_task_from_row,
                    )
                    .optional()
                    .map_err(db_error)?
                    .ok_or_else(|| {
                        OpenBitFunError::tool(format!("Background task was not found: {bg_task_id}"))
                    })?;
                if record.delivered_at_ms.is_none() {
                    records.push(record);
                }
            }
            Ok(records)
        })
        .await
    }

    pub(crate) async fn records_by_task_pks(
        &self,
        task_pks: &[i64],
    ) -> OpenBitFunResult<Vec<BackgroundTaskRecord>> {
        let task_pks = task_pks.to_vec();
        self.with_connection(move |connection| {
            let mut records = Vec::with_capacity(task_pks.len());
            for task_pk in task_pks {
                if let Some(record) = connection
                    .query_row(
                        &format!("{} WHERE tasks.task_pk = ?1", BACKGROUND_TASK_SELECT),
                        params![task_pk],
                        background_task_from_row,
                    )
                    .optional()
                    .map_err(db_error)?
                {
                    records.push(record);
                }
            }
            Ok(records)
        })
        .await
    }

    pub(crate) async fn claim_terminal_tasks(
        &self,
        parent_session_id: &str,
        task_pks: &[i64],
        delivered_parent_dialog_turn_id: &str,
    ) -> OpenBitFunResult<Vec<BackgroundTaskRecord>> {
        let parent_session_id = parent_session_id.to_string();
        let task_pks = task_pks.to_vec();
        let delivered_parent_dialog_turn_id = delivered_parent_dialog_turn_id.to_string();
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let mut claimed = Vec::new();
            for task_pk in task_pks {
                let changed = transaction
                    .execute(
                        r#"
UPDATE background_tasks
SET delivered_at_ms = ?1, delivered_parent_dialog_turn_id = ?2
WHERE task_pk = ?3
  AND parent_session_id = ?4
  AND status != 'running'
  AND delivered_at_ms IS NULL
                        "#,
                        params![
                            unix_time_ms() as i64,
                            delivered_parent_dialog_turn_id,
                            task_pk,
                            parent_session_id,
                        ],
                    )
                    .map_err(db_error)?;
                if changed == 0 {
                    continue;
                }
                claimed.push(
                    transaction
                        .query_row(
                            &format!("{} WHERE tasks.task_pk = ?1", BACKGROUND_TASK_SELECT),
                            params![task_pk],
                            background_task_from_row,
                        )
                        .map_err(db_error)?,
                );
            }
            transaction.commit().map_err(db_error)?;
            Ok(claimed)
        })
        .await
    }

    pub(crate) async fn stale_running_tasks(
        &self,
        parent_session_id: &str,
    ) -> OpenBitFunResult<Vec<BackgroundTaskRecord>> {
        let parent_session_id = parent_session_id.to_string();
        let execution_owner_token = self.execution_owner_token.clone();
        self.with_connection(move |connection| {
            let mut statement = connection
                .prepare(&format!(
                    "{} WHERE tasks.parent_session_id = ?1 AND tasks.status = 'running' AND tasks.execution_owner_token != ?2",
                    BACKGROUND_TASK_SELECT
                ))
                .map_err(db_error)?;
            let rows = statement
                .query_map(
                    params![parent_session_id, execution_owner_token],
                    background_task_from_row,
                )
                .map_err(db_error)?;
            collect_rows(rows)
        })
        .await
    }

    pub(crate) async fn delete_session_references(
        &self,
        session_id: &str,
    ) -> OpenBitFunResult<Vec<i64>> {
        let session_id = session_id.to_string();
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let deleted_task_pks = {
                let mut statement = transaction
                    .prepare(
                        "SELECT task_pk FROM background_tasks WHERE parent_session_id = ?1 OR agent_pk IN (SELECT agent_pk FROM agents WHERE child_session_id = ?1)",
                    )
                    .map_err(db_error)?;
                let task_pks = statement
                    .query_map(params![session_id], |row| row.get::<_, i64>(0))
                    .map_err(db_error)?
                    .collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(db_error)?;
                task_pks
            };
            transaction
                .execute(
                    "DELETE FROM background_tasks WHERE parent_session_id = ?1 OR agent_pk IN (SELECT agent_pk FROM agents WHERE child_session_id = ?1)",
                    params![session_id],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM agents WHERE parent_session_id = ?1",
                    params![session_id],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE agents SET child_session_id = NULL, state = 'historical' WHERE child_session_id = ?1",
                    params![session_id],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM coordination_sessions WHERE parent_session_id = ?1",
                    params![session_id],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM swarm_nodes WHERE session_id = ?1",
                    params![session_id],
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "DELETE FROM swarm_trees WHERE root_session_id = ?1",
                    params![session_id],
                )
                .map_err(db_error)?;
            transaction.commit().map_err(db_error)?;
            Ok(deleted_task_pks)
        })
        .await
    }

    pub(crate) async fn rollback_parent_turns(
        &self,
        parent_session_id: &str,
        parent_dialog_turn_ids: &[String],
    ) -> OpenBitFunResult<Vec<i64>> {
        let parent_session_id = parent_session_id.to_string();
        let parent_dialog_turn_ids = parent_dialog_turn_ids.to_vec();
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let mut deleted_task_pks = Vec::new();
            for turn_id in parent_dialog_turn_ids {
                {
                    let mut statement = transaction
                        .prepare(
                            "SELECT task_pk FROM background_tasks WHERE parent_session_id = ?1 AND parent_dialog_turn_id = ?2",
                        )
                        .map_err(db_error)?;
                    deleted_task_pks.extend(
                        statement
                            .query_map(params![parent_session_id, turn_id], |row| {
                                row.get::<_, i64>(0)
                            })
                            .map_err(db_error)?
                            .collect::<rusqlite::Result<Vec<_>>>()
                            .map_err(db_error)?,
                    );
                }
                transaction
                    .execute(
                        "DELETE FROM background_tasks WHERE parent_session_id = ?1 AND parent_dialog_turn_id = ?2",
                        params![parent_session_id, turn_id],
                    )
                    .map_err(db_error)?;
                transaction
                    .execute(
                        "UPDATE background_tasks SET delivered_at_ms = NULL, delivered_parent_dialog_turn_id = NULL WHERE parent_session_id = ?1 AND delivered_parent_dialog_turn_id = ?2",
                        params![parent_session_id, turn_id],
                    )
                    .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)?;
            Ok(deleted_task_pks)
        })
        .await
    }

    pub(crate) async fn initialize_fork(
        &self,
        source_parent_session_id: &str,
        target_parent_session_id: &str,
    ) -> OpenBitFunResult<()> {
        let source_parent_session_id = source_parent_session_id.to_string();
        let target_parent_session_id = target_parent_session_id.to_string();
        self.with_connection(move |connection| {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let next_auto_agent_seq = transaction
                .query_row(
                    "SELECT next_auto_agent_seq FROM coordination_sessions WHERE parent_session_id = ?1",
                    params![source_parent_session_id],
                    |row| row.get::<_, i64>(0),
                )
                .optional()
                .map_err(db_error)?
                .unwrap_or(1);
            transaction
                .execute(
                    "INSERT OR IGNORE INTO coordination_sessions (parent_session_id, next_auto_agent_seq, updated_at_ms) VALUES (?1, ?2, ?3)",
                    params![target_parent_session_id, next_auto_agent_seq, unix_time_ms() as i64],
                )
                .map_err(db_error)?;

            let reservations = {
                let mut statement = transaction
                    .prepare(
                        "SELECT agent_id, next_bg_seq FROM agents WHERE parent_session_id = ?1 ORDER BY agent_pk",
                    )
                    .map_err(db_error)?;
                let rows = statement
                    .query_map(params![source_parent_session_id], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                    })
                    .map_err(db_error)?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
                    .map_err(db_error)?
            };
            for (agent_id, next_bg_seq) in reservations {
                transaction
                    .execute(
                        "INSERT OR IGNORE INTO agents (parent_session_id, agent_id, child_session_id, next_bg_seq, state, created_at_ms) VALUES (?1, ?2, NULL, ?3, 'historical', ?4)",
                        params![target_parent_session_id, agent_id, next_bg_seq, unix_time_ms() as i64],
                    )
                    .map_err(db_error)?;
            }
            transaction.commit().map_err(db_error)?;
            Ok(())
        })
        .await
    }
}

const BACKGROUND_TASK_SELECT: &str = r#"
SELECT
    tasks.task_pk,
    tasks.parent_session_id,
    agents.agent_id,
    tasks.bg_task_id,
    agents.child_session_id,
    tasks.parent_dialog_turn_id,
    tasks.parent_tool_call_id,
    tasks.child_dialog_turn_id,
    tasks.status,
    tasks.error_code,
    tasks.error_message,
    tasks.execution_owner_token,
    tasks.delivered_at_ms
FROM background_tasks AS tasks
JOIN agents ON agents.agent_pk = tasks.agent_pk
"#;

fn background_task_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BackgroundTaskRecord> {
    let status = row.get::<_, String>(8)?;
    let status = BackgroundTaskStatus::parse(&status).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            8,
            rusqlite::types::Type::Text,
            Box::new(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error.to_string(),
            )),
        )
    })?;
    let delivered_at_ms = row
        .get::<_, Option<i64>>(12)?
        .and_then(|value| u64::try_from(value).ok());
    Ok(BackgroundTaskRecord {
        task_pk: row.get(0)?,
        parent_session_id: row.get(1)?,
        agent_id: row.get(2)?,
        bg_task_id: row.get(3)?,
        child_session_id: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
        parent_dialog_turn_id: row.get(5)?,
        parent_tool_call_id: row.get(6)?,
        child_dialog_turn_id: row.get(7)?,
        status,
        error_code: row.get(9)?,
        error_message: row.get(10)?,
        execution_owner_token: row.get(11)?,
        delivered_at_ms,
    })
}

fn collect_rows(
    rows: rusqlite::MappedRows<
        '_,
        impl FnMut(&rusqlite::Row<'_>) -> rusqlite::Result<BackgroundTaskRecord>,
    >,
) -> OpenBitFunResult<Vec<BackgroundTaskRecord>> {
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(db_error)
}

fn get_or_create_agent(
    transaction: &Transaction<'_>,
    parent_session_id: &str,
    child_session_id: &str,
    requested_agent_id: Option<&str>,
) -> OpenBitFunResult<(i64, String)> {
    if let Some(existing) = transaction
        .query_row(
            "SELECT agent_pk, agent_id FROM agents WHERE parent_session_id = ?1 AND child_session_id = ?2",
            params![parent_session_id, child_session_id],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(db_error)?
    {
        if requested_agent_id.is_some_and(|requested_agent_id| existing.1 != requested_agent_id) {
            return Err(OpenBitFunError::tool(format!(
                "Subagent session is already registered as agent_id={}",
                existing.1
            )));
        }
        return Ok(existing);
    }

    transaction
        .execute(
            "INSERT OR IGNORE INTO coordination_sessions (parent_session_id, next_auto_agent_seq, updated_at_ms) VALUES (?1, 1, ?2)",
            params![parent_session_id, unix_time_ms() as i64],
        )
        .map_err(db_error)?;

    let agent_id = match requested_agent_id {
        Some(agent_id) => {
            validate_agent_id(agent_id)?;
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM agents WHERE parent_session_id = ?1 AND agent_id = ?2",
                    params![parent_session_id, agent_id],
                    |_row| Ok(()),
                )
                .optional()
                .map_err(db_error)?
                .is_some();
            if exists {
                return Err(OpenBitFunError::tool(format!(
                    "agent_id is already reserved in this parent session: {agent_id}"
                )));
            }
            agent_id.to_string()
        }
        None => loop {
            let next = transaction
                .query_row(
                    "SELECT next_auto_agent_seq FROM coordination_sessions WHERE parent_session_id = ?1",
                    params![parent_session_id],
                    |row| row.get::<_, i64>(0),
                )
                .map_err(db_error)?;
            transaction
                .execute(
                    "UPDATE coordination_sessions SET next_auto_agent_seq = ?1, updated_at_ms = ?2 WHERE parent_session_id = ?3",
                    params![next.saturating_add(1), unix_time_ms() as i64, parent_session_id],
                )
                .map_err(db_error)?;
            let candidate = format!("a{next}");
            let exists = transaction
                .query_row(
                    "SELECT 1 FROM agents WHERE parent_session_id = ?1 AND agent_id = ?2",
                    params![parent_session_id, candidate],
                    |_row| Ok(()),
                )
                .optional()
                .map_err(db_error)?
                .is_some();
            if !exists {
                break candidate;
            }
        },
    };

    transaction
        .execute(
            "INSERT INTO agents (parent_session_id, agent_id, child_session_id, next_bg_seq, state, created_at_ms) VALUES (?1, ?2, ?3, 1, 'active', ?4)",
            params![parent_session_id, agent_id, child_session_id, unix_time_ms() as i64],
        )
        .map_err(|error| {
            OpenBitFunError::tool(format!(
                "Failed to register agent_id={agent_id} for the parent session: {error}"
            ))
        })?;
    Ok((transaction.last_insert_rowid(), agent_id))
}

pub(crate) fn validate_agent_id(agent_id: &str) -> OpenBitFunResult<()> {
    validate_coordination_agent_id(agent_id)
}

fn open_connection(db_path: PathBuf) -> OpenBitFunResult<Arc<Mutex<Connection>>> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            OpenBitFunError::io(format!(
                "Failed to create agent coordination database directory {}: {error}",
                parent.display()
            ))
        })?;
    }
    let connection = Connection::open(&db_path).map_err(|error| {
        OpenBitFunError::io(format!(
            "Failed to open agent coordination database {}: {error}",
            db_path.display()
        ))
    })?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(db_error)?;
    connection
        .execute_batch(
            r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;
            "#,
        )
        .map_err(db_error)?;
    initialize_coordination_schema(&connection)?;
    Ok(Arc::new(Mutex::new(connection)))
}

fn db_error(error: rusqlite::Error) -> OpenBitFunError {
    OpenBitFunError::io(format!("Agent coordination database error: {error}"))
}

fn unix_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::coordination_persistence::initialize_coordination_schema;
    use openbitfun_services_core::coordination_persistence::coordination_table_has_column;

    fn test_tempdir() -> tempfile::TempDir {
        if let Some(root) = std::env::var_os("OPENBITFUN_TEST_TMPDIR") {
            let root = PathBuf::from(root);
            std::fs::create_dir_all(&root).expect("create coordination test temp root");
            return tempfile::Builder::new()
                .prefix("coordination-store-")
                .tempdir_in(root)
                .expect("coordination store temp directory");
        }
        tempfile::tempdir().expect("coordination store temp directory")
    }

    fn test_store() -> (tempfile::TempDir, CoordinationStore) {
        let root = test_tempdir();
        let store = CoordinationStore::new(root.path().join("coordination.sqlite"));
        (root, store)
    }

    fn registration(
        parent_session_id: &str,
        child_session_id: &str,
        parent_dialog_turn_id: &str,
        requested_agent_id: Option<&str>,
    ) -> BackgroundTaskRegistration {
        BackgroundTaskRegistration {
            parent_session_id: parent_session_id.to_string(),
            requested_agent_id: requested_agent_id.map(str::to_string),
            child_session_id: child_session_id.to_string(),
            parent_dialog_turn_id: parent_dialog_turn_id.to_string(),
            parent_tool_call_id: format!("tool-{parent_dialog_turn_id}"),
            child_dialog_turn_id: format!("turn-{child_session_id}-{parent_dialog_turn_id}"),
        }
    }

    #[tokio::test]
    async fn schema_v2_repairs_missing_delivery_columns_idempotently() {
        let root = test_tempdir();
        let db_path = root.path().join("coordination.sqlite");
        let connection = Connection::open(&db_path).expect("open historical database");
        connection
            .execute_batch(
                r#"
CREATE TABLE coordination_sessions (
    parent_session_id TEXT PRIMARY KEY,
    next_auto_agent_seq INTEGER NOT NULL DEFAULT 1,
    updated_at_ms INTEGER NOT NULL
);
CREATE TABLE agents (
    agent_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    child_session_id TEXT,
    next_bg_seq INTEGER NOT NULL DEFAULT 1,
    state TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE background_tasks (
    task_pk INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_session_id TEXT NOT NULL,
    agent_pk INTEGER NOT NULL,
    bg_task_id TEXT NOT NULL,
    bg_ordinal INTEGER NOT NULL,
    parent_dialog_turn_id TEXT NOT NULL,
    parent_tool_call_id TEXT NOT NULL,
    child_dialog_turn_id TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT,
    error_message TEXT,
    execution_owner_token TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    terminal_at_ms INTEGER
);
CREATE TABLE swarm_trees (
    root_session_id TEXT PRIMARY KEY,
    created_at_ms INTEGER NOT NULL
);
CREATE TABLE swarm_nodes (
    session_id TEXT PRIMARY KEY,
    root_session_id TEXT NOT NULL,
    parent_session_id TEXT,
    agent_type TEXT NOT NULL,
    depth INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL
);
INSERT INTO coordination_sessions VALUES ('parent', 2, 1);
INSERT INTO agents VALUES (1, 'parent', 'helper', 'child', 2, 'historical', 1);
INSERT INTO background_tasks VALUES (
    1, 'parent', 1, 'helper_bg1', 1, 'parent-turn', 'tool-call',
    'child-turn', 'completed', NULL, NULL, 'historical-owner', 1, 2
);
PRAGMA user_version = 2;
                "#,
            )
            .expect("seed historical schema v2");
        drop(connection);

        let store = CoordinationStore::new(db_path.clone());
        let candidates = store
            .wait_candidates("parent", &[])
            .await
            .expect("repaired database should support current reads");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].bg_task_id, "helper_bg1");
        assert!(candidates[0].delivered_at_ms.is_none());
        drop(store);

        let connection = Connection::open(&db_path).expect("reopen repaired database");
        initialize_coordination_schema(&connection).expect("repeated repair should be idempotent");
        assert!(
            coordination_table_has_column(&connection, "background_tasks", "delivered_at_ms")
                .expect("inspect delivered_at_ms")
        );
        assert!(coordination_table_has_column(
            &connection,
            "background_tasks",
            "delivered_parent_dialog_turn_id"
        )
        .expect("inspect delivered_parent_dialog_turn_id"));
    }

    #[tokio::test]
    async fn model_ids_are_parent_scoped_and_task_ids_are_agent_scoped() {
        let (_root, store) = test_store();

        let first = store
            .register_background_task(registration("parent-1", "child-1", "parent-turn-1", None))
            .await
            .expect("register first task");
        let second = store
            .register_background_task(registration("parent-1", "child-1", "parent-turn-2", None))
            .await
            .expect("register second task");
        let named = store
            .register_background_task(registration(
                "parent-1",
                "child-reviewer",
                "parent-turn-3",
                Some("reviewer"),
            ))
            .await
            .expect("register named agent task");
        assert_eq!(
            store
                .existing_agent_id_for_session("parent-1", "child-reviewer")
                .await
                .expect("read existing named agent")
                .as_deref(),
            Some("reviewer")
        );
        assert!(store
            .existing_agent_id_for_session("parent-1", "missing-session")
            .await
            .expect("missing sessions should not allocate an agent id")
            .is_none());
        let other_parent = store
            .register_background_task(registration("parent-2", "child-2", "parent-turn-1", None))
            .await
            .expect("register task for another parent");

        assert_eq!(
            (first.agent_id.as_str(), first.bg_task_id.as_str()),
            ("a1", "a1_bg1")
        );
        assert_eq!(
            (second.agent_id.as_str(), second.bg_task_id.as_str()),
            ("a1", "a1_bg2")
        );
        assert_eq!(
            (named.agent_id.as_str(), named.bg_task_id.as_str()),
            ("reviewer", "reviewer_bg1")
        );
        assert_eq!(
            (
                other_parent.agent_id.as_str(),
                other_parent.bg_task_id.as_str()
            ),
            ("a1", "a1_bg1")
        );
        assert_eq!(
            store
                .resolve_agent_id("parent-1", "reviewer")
                .await
                .expect("resolve named agent"),
            "child-reviewer"
        );
    }

    #[tokio::test]
    async fn caller_selected_foreground_agent_id_is_registered_and_resolvable() {
        let (_root, store) = test_store();

        let agent_id = store
            .agent_id_for_session_with_requested_id(
                "parent",
                "foreground-child",
                Some("parser-review"),
            )
            .await
            .expect("register caller-selected foreground agent id");

        assert_eq!(agent_id, "parser-review");
        assert_eq!(
            store
                .resolve_agent_id("parent", "parser-review")
                .await
                .expect("resolve caller-selected foreground agent id"),
            "foreground-child"
        );
    }

    #[tokio::test]
    async fn discarding_unsubmitted_spawn_releases_its_agent_id() {
        let (_root, store) = test_store();
        let registered = store
            .register_background_task(registration(
                "parent",
                "unsubmitted-child",
                "spawn-turn",
                Some("parser-review"),
            ))
            .await
            .expect("register unsubmitted spawn");

        let released = store
            .discard_unsubmitted_background_task(registered.task_pk, true)
            .await
            .expect("discard unsubmitted spawn");
        assert!(released);

        assert!(store
            .resolve_agent_id("parent", "parser-review")
            .await
            .is_err());
        let retried = store
            .register_background_task(registration(
                "parent",
                "retry-child",
                "retry-turn",
                Some("parser-review"),
            ))
            .await
            .expect("retry should reuse the caller-selected agent id");
        assert_eq!(retried.agent_id, "parser-review");
    }

    #[tokio::test]
    async fn discarding_unsubmitted_follow_up_preserves_its_agent() {
        let (_root, store) = test_store();
        store
            .register_background_task(registration(
                "parent",
                "existing-child",
                "spawn-turn",
                Some("parser-review"),
            ))
            .await
            .expect("register existing agent");
        let follow_up = store
            .register_background_task(registration(
                "parent",
                "existing-child",
                "follow-up-turn",
                None,
            ))
            .await
            .expect("register unsubmitted follow-up");

        let released = store
            .discard_unsubmitted_background_task(follow_up.task_pk, false)
            .await
            .expect("discard unsubmitted follow-up");
        assert!(!released);

        assert_eq!(
            store
                .resolve_agent_id("parent", "parser-review")
                .await
                .expect("existing agent should remain addressable"),
            "existing-child"
        );
    }

    #[tokio::test]
    async fn swarm_root_identity_preserves_legacy_trees_and_writes_canonical_new_roots() {
        let (_root, store) = test_store();
        store
            .with_connection(|connection| {
                connection
                    .execute_batch(
                        "INSERT INTO swarm_trees VALUES ('legacy-root', 1);
                         INSERT INTO swarm_nodes VALUES ('legacy-root', 'legacy-root', NULL, 'Ultra', 0, 1);
                         INSERT INTO swarm_nodes VALUES ('existing-planner', 'legacy-root', 'legacy-root', 'SwarmPlanner', 1, 1);",
                    )
                    .map_err(db_error)
            })
            .await
            .expect("seed a legacy tree");

        store
            .reserve_swarm_child("legacy-root", "new-planner", "Ultimate", "SwarmPlanner", 1)
            .await
            .expect("a legacy root remains usable after an upgrade");
        store
            .reserve_swarm_child(
                "current-root",
                "current-planner",
                "Ultimate",
                "SwarmPlanner",
                1,
            )
            .await
            .expect("create a tree with the canonical identity");

        assert_eq!(
            store
                .swarm_depth_for_session("existing-planner")
                .await
                .unwrap(),
            Some(1)
        );
        store
            .with_connection(|connection| {
                for (session_id, expected) in
                    [("legacy-root", "Ultra"), ("current-root", "Ultimate")]
                {
                    let stored_identity: String = connection
                        .query_row(
                            "SELECT agent_type FROM swarm_nodes WHERE session_id = ?1",
                            params![session_id],
                            |row| row.get(0),
                        )
                        .map_err(db_error)?;
                    assert_eq!(stored_identity, expected);
                }
                Ok(())
            })
            .await
            .expect("legacy rows remain intact and new rows use canonical identities");
    }

    #[tokio::test]
    async fn swarm_admission_enforces_depth_and_tree_size_budgets() {
        let (_root, store) = test_store();
        store
            .reserve_swarm_child("root", "planner", "Ultimate", "SwarmPlanner", 1)
            .await
            .expect("reserve planner");
        store
            .reserve_swarm_child(
                "unregistered-planner",
                "orphan-worker",
                "SwarmPlanner",
                "SwarmWorker",
                1,
            )
            .await
            .expect_err("a non-Ultra session cannot create a new Swarm tree");
        store
            .reserve_swarm_child("planner", "spoofed-worker", "Ultimate", "SwarmWorker", 2)
            .await
            .expect_err("the runtime parent type must match the persisted tree node");
        store
            .reserve_swarm_child("planner", "worker", "SwarmPlanner", "SwarmWorker", 2)
            .await
            .expect("reserve worker");
        store
            .reserve_swarm_child("worker", "invalid-child", "SwarmWorker", "SwarmWorker", 3)
            .await
            .expect_err("worker cannot launch children");
        store
            .reserve_swarm_child("worker", "leaf-reviewer", "SwarmWorker", "SwarmReviewer", 3)
            .await
            .expect_err("a worker cannot launch a reviewer either");
        store
            .reserve_swarm_child(
                "planner",
                "nested-planner",
                "SwarmPlanner",
                "SwarmPlanner",
                2,
            )
            .await
            .expect("reserve nested planner");
        store
            .reserve_swarm_child(
                "nested-planner",
                "deep-planner",
                "SwarmPlanner",
                "SwarmPlanner",
                3,
            )
            .await
            .expect("reserve planner on the penultimate level");
        store
            .reserve_swarm_child(
                "deep-planner",
                "final-worker",
                "SwarmPlanner",
                "SwarmWorker",
                4,
            )
            .await
            .expect("reserve worker on the final level");
        store
            .reserve_swarm_child(
                "deep-planner",
                "final-planner",
                "SwarmPlanner",
                "SwarmPlanner",
                4,
            )
            .await
            .expect_err("final tree level cannot contain a planner");
        store
            .reserve_swarm_child(
                "final-worker",
                "beyond-final-level",
                "SwarmWorker",
                "SwarmWorker",
                5,
            )
            .await
            .expect_err("a sixth tree level must be rejected");
        store
            .reserve_swarm_child(
                "nested-planner",
                "nested-worker",
                "SwarmPlanner",
                "SwarmWorker",
                3,
            )
            .await
            .expect("reserve nested worker");
        assert_eq!(
            store
                .agent_subtree_session_ids_postorder("planner")
                .await
                .expect("load persisted descendants")
                .into_iter()
                .collect::<std::collections::HashSet<_>>(),
            [
                "planner".to_string(),
                "worker".to_string(),
                "nested-planner".to_string(),
                "deep-planner".to_string(),
                "final-worker".to_string(),
                "nested-worker".to_string(),
            ]
            .into_iter()
            .collect()
        );

        // A planner may use the rest of the tree budget for direct children.
        // The seven existing nodes plus these 121 fill the 128-node tree.
        for index in 0..121 {
            store
                .reserve_swarm_child(
                    "planner",
                    &format!("reviewer-{index}"),
                    "SwarmPlanner",
                    "SwarmReviewer",
                    2,
                )
                .await
                .expect("reserve direct planner child");
        }
        store
            .reserve_swarm_child(
                "planner",
                "over-tree-budget",
                "SwarmPlanner",
                "SwarmReviewer",
                2,
            )
            .await
            .expect_err("whole-tree node budget should be enforced");
    }

    #[tokio::test]
    async fn terminal_transition_and_delivery_claim_are_single_winner() {
        let (_root, store) = test_store();
        let task = store
            .register_background_task(registration("parent", "child", "spawn-turn", None))
            .await
            .expect("register task");

        assert!(store
            .update_task_status(task.task_pk, BackgroundTaskStatus::Completed, None, None)
            .await
            .expect("complete task"));
        assert!(!store
            .update_task_status(
                task.task_pk,
                BackgroundTaskStatus::Cancelled,
                Some("late_cancel".to_string()),
                Some("late cancellation".to_string()),
            )
            .await
            .expect("late terminal transition"));

        let first_claim = store
            .claim_terminal_tasks("parent", &[task.task_pk], "wait-turn-1")
            .await
            .expect("claim completed task");
        let second_claim = store
            .claim_terminal_tasks("parent", &[task.task_pk], "wait-turn-2")
            .await
            .expect("repeat claim");
        assert_eq!(first_claim.len(), 1);
        assert_eq!(first_claim[0].status, BackgroundTaskStatus::Completed);
        assert!(second_claim.is_empty());
    }

    #[tokio::test]
    async fn direct_child_agents_without_swarm_nodes_survive_reopen_and_cleanup() {
        let (root, store) = test_store();
        let task = store
            .register_background_task(registration("parent", "child", "spawn", Some("helper")))
            .await
            .expect("register ordinary background agent");
        store
            .register_background_task(registration(
                "other-parent",
                "other-child",
                "spawn",
                Some("helper"),
            ))
            .await
            .expect("register same agent id under another parent");
        let agents = store
            .direct_child_agents("parent")
            .await
            .expect("list running agent");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].status, BackgroundTaskStatus::Running);
        store
            .update_task_status(task.task_pk, BackgroundTaskStatus::Completed, None, None)
            .await
            .expect("complete ordinary task");
        store
            .claim_terminal_tasks("parent", &[task.task_pk], "wait")
            .await
            .expect("deliver ordinary task result");
        drop(store);

        // Existing agents-only records must work after reopening, without a data migration.
        let store = CoordinationStore::new(root.path().join("coordination.sqlite"));
        let agents = store
            .direct_child_agents("parent")
            .await
            .expect("list persisted agent");
        assert_eq!(
            agents,
            vec![DirectChildAgentRecord {
                agent_id: "helper".to_string(),
                child_session_id: "child".to_string(),
                status: BackgroundTaskStatus::Completed,
                background_turn_id: Some("turn-child-spawn".to_string()),
            }]
        );
        assert_eq!(
            store
                .resolve_direct_child_agent_id("parent", "helper")
                .await
                .expect("resolve ordinary child"),
            "child"
        );
        assert_eq!(
            store
                .resolve_direct_child_agent_id("other-parent", "helper")
                .await
                .expect("resolve other parent's child"),
            "other-child"
        );
        store
            .resolve_direct_child_agent_id("unrelated", "helper")
            .await
            .expect_err("reject unrelated parent");
        store
            .delete_session_references("child")
            .await
            .expect("clean up child");
        assert!(store
            .direct_child_agents("parent")
            .await
            .expect("list after cleanup")
            .is_empty());
        store
            .resolve_direct_child_agent_id("parent", "helper")
            .await
            .expect_err("reject historical child");
        assert_eq!(
            store
                .direct_child_agents("other-parent")
                .await
                .expect("keep other parent's child")
                .len(),
            1
        );
        drop(store);
        let store = CoordinationStore::new(root.path().join("coordination.sqlite"));
        assert_eq!(
            store.reserved_agent_ids("parent").await.unwrap(),
            vec!["helper"]
        );
        assert!(store
            .reserved_agent_ids("other-parent")
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .reserved_agent_ids("unrelated")
            .await
            .unwrap()
            .is_empty());
    }

    #[tokio::test]
    async fn direct_child_subtree_includes_ordinary_agents_and_reserved_swarm_nodes() {
        let (_root, store) = test_store();
        for (parent, child, agent_id) in [
            ("root", "child", "helper"),
            ("child", "grandchild", "nested"),
            ("root", "sibling", "sibling"),
        ] {
            store
                .agent_id_for_session_with_requested_id(parent, child, Some(agent_id))
                .await
                .expect("register ordinary foreground agent");
        }
        store
            .resolve_direct_child_agent_id("root", "nested")
            .await
            .expect_err("reject grandchild");
        assert_eq!(
            store
                .agent_subtree_session_ids_postorder("child")
                .await
                .expect("ordinary subtree"),
            ["grandchild", "child"]
        );
        assert_eq!(
            store
                .agent_subtree_session_ids_postorder("sibling")
                .await
                .expect("ordinary leaf"),
            ["sibling"]
        );
        assert!(store
            .agent_subtree_session_ids_postorder("missing")
            .await
            .expect("unknown subtree")
            .is_empty());

        store
            .reserve_swarm_child("swarm-root", "planner", "Ultimate", "SwarmPlanner", 1)
            .await
            .expect("reserve planner");
        store
            .register_background_task(registration("swarm-root", "planner", "spawn", None))
            .await
            .expect("register planner");
        store
            .reserve_swarm_child(
                "planner",
                "reserved-worker",
                "SwarmPlanner",
                "SwarmWorker",
                2,
            )
            .await
            .expect("reserve worker before task registration");
        store
            .agent_id_for_session_with_requested_id("planner", "ordinary-worker", None)
            .await
            .expect("register ordinary child alongside swarm child");
        assert_eq!(
            store
                .agent_subtree_session_ids_postorder("planner")
                .await
                .expect("mixed subtree"),
            ["ordinary-worker", "reserved-worker", "planner"]
        );
    }

    #[tokio::test]
    async fn direct_child_agents_use_latest_status_and_ignore_delivery() {
        let (_root, store) = test_store();
        store
            .reserve_swarm_child("root", "planner", "Ultimate", "SwarmPlanner", 1)
            .await
            .expect("reserve planner");
        store
            .reserve_swarm_child("planner", "worker", "SwarmPlanner", "SwarmWorker", 2)
            .await
            .expect("reserve nested worker");
        let first = store
            .register_background_task(registration("root", "planner", "spawn-turn", None))
            .await
            .expect("register first task");
        let latest = store
            .register_background_task(registration("root", "planner", "follow-up-turn", None))
            .await
            .expect("register latest task");
        store
            .register_background_task(registration("planner", "worker", "nested-turn", None))
            .await
            .expect("register nested task");
        store
            .update_task_status(first.task_pk, BackgroundTaskStatus::Failed, None, None)
            .await
            .expect("fail first task");
        store
            .update_task_status(latest.task_pk, BackgroundTaskStatus::Completed, None, None)
            .await
            .expect("complete latest task");
        store
            .claim_terminal_tasks("root", &[latest.task_pk], "wait-turn")
            .await
            .expect("consume latest result");

        let agents = store
            .direct_child_agents("root")
            .await
            .expect("list direct children");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].agent_id, first.agent_id);
        assert_eq!(agents[0].child_session_id, "planner");
        assert_eq!(agents[0].status, BackgroundTaskStatus::Completed);

        store
            .delete_session_references("planner")
            .await
            .expect("delete planner references");
        assert!(store
            .direct_child_agents("root")
            .await
            .expect("list children after deletion")
            .is_empty());
        store
            .resolve_direct_child_agent_id("root", &first.agent_id)
            .await
            .expect_err("deleted agent id must no longer resolve");
        let duplicate = store
            .register_background_task(registration(
                "root",
                "replacement-planner",
                "spawn-turn-3",
                Some(&first.agent_id),
            ))
            .await
            .expect_err("deleted agent ids remain reserved by their parent session");
        assert!(duplicate
            .to_string()
            .contains("agent_id is already reserved in this parent session"));
    }

    #[tokio::test]
    async fn direct_child_resolution_and_subtree_postorder_are_lineage_scoped() {
        let (_root, store) = test_store();
        store
            .reserve_swarm_child("root", "planner", "Ultimate", "SwarmPlanner", 1)
            .await
            .expect("reserve planner");
        store
            .reserve_swarm_child("planner", "worker", "SwarmPlanner", "SwarmWorker", 2)
            .await
            .expect("reserve worker");
        let planner = store
            .register_background_task(registration("root", "planner", "planner-turn", None))
            .await
            .expect("register planner");
        let worker = store
            .register_background_task(registration(
                "planner",
                "worker",
                "worker-turn",
                Some("nested-worker"),
            ))
            .await
            .expect("register worker");

        assert_eq!(
            store
                .resolve_direct_child_agent_id("root", &planner.agent_id)
                .await
                .expect("resolve direct planner"),
            "planner"
        );
        store
            .resolve_direct_child_agent_id("root", &worker.agent_id)
            .await
            .expect_err("a grandchild is not a direct child of root");
        assert_eq!(
            store
                .agent_subtree_session_ids_postorder("planner")
                .await
                .expect("load subtree"),
            ["worker", "planner"]
        );
    }

    #[tokio::test]
    async fn stale_running_tasks_can_only_be_reconciled_once() {
        let root = tempfile::tempdir().expect("coordination store temp directory");
        let db_path = root.path().join("coordination.sqlite");
        let first_owner = CoordinationStore::new(db_path.clone());
        let task = first_owner
            .register_background_task(registration("parent", "child", "spawn-turn", None))
            .await
            .expect("register running task");
        let second_owner = CoordinationStore::new(db_path);

        let stale = second_owner
            .stale_running_tasks("parent")
            .await
            .expect("load stale running tasks");
        assert_eq!(stale.len(), 1);
        assert_eq!(stale[0].task_pk, task.task_pk);
        assert!(second_owner
            .update_task_status(
                task.task_pk,
                BackgroundTaskStatus::Interrupted,
                Some("execution_interrupted".to_string()),
                Some("execution interrupted".to_string()),
            )
            .await
            .expect("reconcile stale task"));
        assert!(!first_owner
            .update_task_status(task.task_pk, BackgroundTaskStatus::Completed, None, None)
            .await
            .expect("late original owner completion"));
    }

    #[tokio::test]
    async fn rollback_deletes_spawned_tasks_and_restores_rolled_back_deliveries() {
        let (_root, store) = test_store();
        let delivered = store
            .register_background_task(registration("parent", "child-1", "spawn-turn-1", None))
            .await
            .expect("register delivered task");
        let removed = store
            .register_background_task(registration("parent", "child-2", "spawn-turn-2", None))
            .await
            .expect("register removable task");
        assert!(store
            .update_task_status(
                delivered.task_pk,
                BackgroundTaskStatus::Completed,
                None,
                None,
            )
            .await
            .expect("complete delivered task"));
        store
            .claim_terminal_tasks("parent", &[delivered.task_pk], "delivery-turn")
            .await
            .expect("claim delivered task");

        let deleted = store
            .rollback_parent_turns(
                "parent",
                &["spawn-turn-2".to_string(), "delivery-turn".to_string()],
            )
            .await
            .expect("rollback parent turns");
        assert_eq!(deleted, vec![removed.task_pk]);
        let candidates = store
            .wait_candidates("parent", &[])
            .await
            .expect("load restored candidates");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].task_pk, delivered.task_pk);
        assert!(candidates[0].delivered_at_ms.is_none());
    }

    #[tokio::test]
    async fn fork_preserves_id_reservations_without_copying_tasks() {
        let (_root, store) = test_store();
        let first = store
            .register_background_task(registration("source", "child-1", "spawn-turn-1", None))
            .await
            .expect("register first source agent");
        store
            .agent_id_for_session_with_requested_id("source", "child-2", None)
            .await
            .expect("reserve second source agent");
        store
            .initialize_fork("source", "target")
            .await
            .expect("initialize fork reservations");

        assert!(store
            .wait_candidates("target", &[])
            .await
            .expect("load fork tasks")
            .is_empty());
        let target = store
            .register_background_task(registration("target", "target-child", "spawn-turn", None))
            .await
            .expect("register target task");
        assert_eq!(first.agent_id, "a1");
        assert_eq!(target.agent_id, "a3");
        assert_eq!(target.bg_task_id, "a3_bg1");
        assert_eq!(
            store.reserved_agent_ids("target").await.unwrap(),
            vec!["a1", "a2"]
        );
        assert!(store.reserved_agent_ids("source").await.unwrap().is_empty());
        assert!(store
            .reserved_agent_ids("unrelated")
            .await
            .unwrap()
            .is_empty());
        assert!(store
            .register_background_task(registration(
                "target",
                "explicit-child",
                "explicit-turn",
                Some("a1"),
            ))
            .await
            .is_err());
    }

    #[tokio::test]
    async fn deleting_a_parent_or_child_removes_their_tasks() {
        let (_root, store) = test_store();
        let first = store
            .register_background_task(registration("parent", "child-1", "spawn-turn-1", None))
            .await
            .expect("register first child task");
        let second = store
            .register_background_task(registration("parent", "child-2", "spawn-turn-2", None))
            .await
            .expect("register second child task");

        assert_eq!(
            store
                .delete_session_references("child-1")
                .await
                .expect("delete child references"),
            vec![first.task_pk]
        );
        assert_eq!(
            store
                .delete_session_references("parent")
                .await
                .expect("delete parent references"),
            vec![second.task_pk]
        );
        assert!(store
            .wait_candidates("parent", &[])
            .await
            .expect("load remaining tasks")
            .is_empty());
    }
}
