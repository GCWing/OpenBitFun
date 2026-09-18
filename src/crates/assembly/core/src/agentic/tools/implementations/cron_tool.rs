use super::util::normalize_path;
use crate::agentic::coordination::get_global_coordinator;
use crate::agentic::tools::framework::{
    Tool, ToolExposure, ToolRenderOptions, ToolResult, ToolUseContext, ValidationResult,
};
use crate::agentic::tools::workspace_paths::posix_style_path_is_absolute;
use crate::agentic::workspace::WorkspaceBinding;
use crate::service::{
    cron::{
        CreateCronJobRequest, CronJob, CronJobPayload, CronJobRunStatus, CronJobTarget,
        CronJobTargetKind, CronSchedule, CronWorkspaceRef, UpdateCronJobRequest,
    },
    get_global_cron_service,
};
use crate::service_agent_runtime::CoreServiceAgentRuntime;
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use chrono::{DateTime, Local, SecondsFormat, TimeZone};
use openbitfun_agent_runtime::sdk::AgentRuntime;
use openbitfun_runtime_ports::{
    AgentSessionListRequest, AgentSessionWorkspaceBinding, AgentSessionWorkspaceRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;

const DEFAULT_JOB_NAME: &str = "Cron job";

/// Cron tool - manage scheduled jobs for agent sessions.
pub struct CronTool;

impl CronTool {
    pub fn new() -> Self {
        Self
    }

    fn validate_session_id(session_id: &str) -> Result<(), String> {
        openbitfun_core_types::validate_session_id(session_id)
    }

    fn validate_job_id(job_id: &str) -> Result<(), String> {
        if job_id.trim().is_empty() {
            return Err("job_id cannot be empty".to_string());
        }
        Ok(())
    }

    fn validate_workspace_format(
        workspace: &str,
        context: Option<&ToolUseContext>,
    ) -> Result<(), String> {
        if workspace.trim().is_empty() {
            return Err("workspace cannot be empty".to_string());
        }
        let is_remote = context.map(|c| c.is_remote()).unwrap_or(false);
        if is_remote {
            if !posix_style_path_is_absolute(workspace.trim()) {
                return Err(
                    "workspace must be an absolute POSIX path on the remote host".to_string(),
                );
            }
            return Ok(());
        }
        if !Path::new(workspace.trim()).is_absolute() {
            return Err("workspace must be an absolute path".to_string());
        }
        Ok(())
    }

    fn resolve_workspace(
        &self,
        workspace: &str,
        context: Option<&ToolUseContext>,
    ) -> OpenBitFunResult<String> {
        Self::validate_workspace_format(workspace, context).map_err(OpenBitFunError::tool)?;

        if let Some(ctx) = context {
            if ctx.is_remote() {
                return ctx.resolve_workspace_tool_path(workspace.trim());
            }
        }

        let resolved = normalize_path(workspace.trim());
        let path = Path::new(&resolved);
        if !path.exists() {
            return Err(OpenBitFunError::tool(format!(
                "Workspace does not exist: {}",
                resolved
            )));
        }
        if !path.is_dir() {
            return Err(OpenBitFunError::tool(format!(
                "Workspace is not a directory: {}",
                resolved
            )));
        }
        Ok(resolved)
    }

    fn resolve_workspace_from_context(&self, context: &ToolUseContext) -> OpenBitFunResult<String> {
        let workspace = context.workspace_root().ok_or_else(|| {
            OpenBitFunError::tool(
                "workspace is required when the current workspace is unavailable".to_string(),
            )
        })?;
        self.resolve_workspace(workspace.to_string_lossy().as_ref(), Some(context))
    }

    async fn resolve_effective_workspace_for_session(
        &self,
        session_id: &str,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<CronWorkspaceRef> {
        if let Some(runtime) = Self::agent_runtime()? {
            if let Some(binding) = runtime
                .resolve_session_workspace_binding(AgentSessionWorkspaceRequest {
                    session_id: session_id.to_string(),
                })
                .await
                .map_err(|error| {
                    OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
                })?
            {
                let workspace_ref = Self::workspace_ref_from_agent_binding(binding);
                Self::ensure_target_session_visible(&runtime, &workspace_ref, session_id).await?;
                return Ok(workspace_ref);
            }
        }

        if context.session_id.as_deref() == Some(session_id) {
            if let Some(binding) = context.workspace.as_ref() {
                return Ok(Self::workspace_ref_from_context_binding(binding));
            }
            let resolved = self.resolve_workspace_from_context(context)?;
            return Ok(CronWorkspaceRef {
                workspace_id: None,
                workspace_path: resolved,
                project_workspace_path: None,
                execution_target: None,
                remote_connection_id: None,
                remote_ssh_host: None,
            });
        }

        Err(OpenBitFunError::tool(format!(
            "Unable to resolve workspace for session '{}'",
            session_id
        )))
    }

    fn agent_runtime() -> OpenBitFunResult<Option<AgentRuntime>> {
        let Some(coordinator) = get_global_coordinator() else {
            return Ok(None);
        };
        CoreServiceAgentRuntime::agent_runtime(coordinator)
            .map(Some)
            .map_err(OpenBitFunError::tool)
    }

    async fn ensure_target_session_visible(
        runtime: &AgentRuntime,
        workspace_ref: &CronWorkspaceRef,
        session_id: &str,
    ) -> OpenBitFunResult<()> {
        let sessions = runtime
            .list_sessions(AgentSessionListRequest {
                workspace_id: workspace_ref.workspace_id.clone(),
                workspace_path: String::new(),
                remote_connection_id: None,
                remote_ssh_host: None,
            })
            .await
            .map_err(|error| {
                OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
            })?;
        if sessions
            .iter()
            .any(|session| session.session_id == session_id)
        {
            return Ok(());
        }

        let resolved_agent_type = runtime
            .resolve_session_agent_type(session_id)
            .await
            .map_err(|error| {
                OpenBitFunError::tool(CoreServiceAgentRuntime::runtime_error_message(error))
            })?;
        if resolved_agent_type
            .as_deref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Ok(());
        }

        Err(OpenBitFunError::NotFound(format!(
            "Session '{}' not found in workspace '{}'",
            session_id, workspace_ref.workspace_path
        )))
    }

    fn resolve_effective_session_id(
        &self,
        session_id: Option<&str>,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<String> {
        let resolved = match session_id {
            Some(session_id) => session_id.trim().to_string(),
            None => context
                .session_id
                .as_deref()
                .unwrap_or_default()
                .trim()
                .to_string(),
        };

        Self::validate_session_id(&resolved).map_err(OpenBitFunError::tool)?;
        Ok(resolved)
    }

    /// Whether a schedule fires more than once.
    ///
    /// Only a repeating schedule takes over a cadence the agent would
    /// otherwise drive by hand; a one-shot `at` job is a reminder and says
    /// nothing about what the agent should do with the rest of its turn.
    fn schedule_repeats(schedule: &CronSchedule) -> bool {
        match schedule {
            CronSchedule::At { .. } => false,
            CronSchedule::Every { .. } | CronSchedule::Cron { .. } => true,
        }
    }

    /// Describe a created job to the model.
    ///
    /// Handing a cadence to the scheduler is a handoff, but creating the job
    /// does not end the turn — no tool can. Saying only "created job X" leaves
    /// `add` looking like any other successful call, so the agent keeps
    /// driving the loop the schedule was meant to take over, and a turn that
    /// outruns the interval delays the very trigger it is racing (a scheduled
    /// run is queued at low priority, never run concurrently).
    fn add_result_summary(job: &CronJob, current_session_id: Option<&str>) -> String {
        let mut summary = format!(
            "Created scheduled job '{}' ({}) for session '{}' in workspace '{}'.",
            job.name,
            job.id,
            job.session_id().unwrap_or(""),
            job.workspace().workspace_path
        );
        if Self::schedule_repeats(&job.schedule) && job.session_id() == current_session_id {
            summary.push_str(
                " The schedule owns this cadence now. Creating the job did not end your turn — finish only what is \
                 already in flight and then end it, instead of starting another round or waiting for one. When the job \
                 fires it delivers its payload to this session as a new user message, and that is what begins the next \
                 round; a turn still running when it fires just makes that round start late.",
            );
        }
        summary
    }

    fn normalize_add_name(name: Option<String>) -> String {
        match name {
            Some(name) if !name.trim().is_empty() => name.trim().to_string(),
            _ => DEFAULT_JOB_NAME.to_string(),
        }
    }

    fn workspace_ref_from_context_binding(binding: &WorkspaceBinding) -> CronWorkspaceRef {
        CronWorkspaceRef {
            workspace_id: binding.workspace_id.clone(),
            workspace_path: binding.root_path_string(),
            project_workspace_path: Some(binding.project_root_path_string()),
            execution_target: binding.execution_target.clone(),
            remote_connection_id: binding.connection_id().map(ToOwned::to_owned),
            remote_ssh_host: if binding.is_remote() {
                Some(binding.session_identity.hostname.clone())
                    .filter(|value| !value.trim().is_empty())
            } else {
                None
            },
        }
    }

    fn workspace_ref_from_agent_binding(binding: AgentSessionWorkspaceBinding) -> CronWorkspaceRef {
        CronWorkspaceRef {
            workspace_id: binding.workspace_id,
            workspace_path: binding.workspace_path,
            project_workspace_path: binding.project_workspace_path,
            execution_target: binding.execution_target,
            remote_connection_id: binding.remote_connection_id,
            remote_ssh_host: binding.remote_ssh_host,
        }
    }

    fn normalize_optional_name(name: Option<String>) -> OpenBitFunResult<Option<String>> {
        match name {
            Some(name) if name.trim().is_empty() => Err(OpenBitFunError::tool(
                "patch.name cannot be empty when provided".to_string(),
            )),
            Some(name) => Ok(Some(name.trim().to_string())),
            None => Ok(None),
        }
    }

    fn validate_payload(payload: &str, field_name: &str) -> OpenBitFunResult<()> {
        if payload.trim().is_empty() {
            return Err(OpenBitFunError::tool(format!(
                "{}.payload must not be empty",
                field_name
            )));
        }
        Ok(())
    }

    fn into_service_payload(payload: String) -> CronJobPayload {
        CronJobPayload { text: payload }
    }

    fn parse_iso_timestamp_ms(value: &str, field_name: &str) -> OpenBitFunResult<i64> {
        let parsed = DateTime::parse_from_rfc3339(value).map_err(|error| {
            OpenBitFunError::tool(format!(
                "{} must be a valid ISO-8601 timestamp: {}",
                field_name, error
            ))
        })?;
        Ok(parsed.timestamp_millis())
    }

    fn format_iso_timestamp_local(timestamp_ms: i64, field_name: &str) -> OpenBitFunResult<String> {
        let datetime = Local
            .timestamp_millis_opt(timestamp_ms)
            .single()
            .ok_or_else(|| {
                OpenBitFunError::tool(format!(
                    "{} timestamp is out of range: {}",
                    field_name, timestamp_ms
                ))
            })?;
        Ok(datetime.to_rfc3339_opts(SecondsFormat::Secs, false))
    }

    fn every_ms_to_seconds(every_ms: u64) -> u64 {
        every_ms.div_ceil(1_000)
    }

    fn seconds_to_every_ms(seconds: u64, field_name: &str) -> OpenBitFunResult<u64> {
        if seconds == 0 {
            return Err(OpenBitFunError::tool(format!(
                "{}.every must be greater than 0 seconds",
                field_name
            )));
        }

        seconds
            .checked_mul(1_000)
            .ok_or_else(|| OpenBitFunError::tool(format!("{}.every is too large", field_name)))
    }

    fn serialize_job(job: &CronJob) -> OpenBitFunResult<Value> {
        serde_json::to_value(CronToolJobOutput::try_from(job)?)
            .map_err(|err| OpenBitFunError::serialization(err.to_string()))
    }

    fn serialize_jobs(jobs: &[CronJob]) -> OpenBitFunResult<Vec<Value>> {
        jobs.iter().map(Self::serialize_job).collect()
    }

    fn escape_markdown_table_cell(value: &str) -> String {
        value
            .replace('\\', "\\\\")
            .replace('|', "\\|")
            .replace('\n', "<br>")
    }

    fn schedule_summary(schedule: &CronSchedule) -> String {
        match schedule {
            CronSchedule::At { at } => format!("at {}", at),
            CronSchedule::Every {
                every_ms,
                anchor_ms,
            } => match anchor_ms {
                Some(anchor_ms) => match Self::format_iso_timestamp_local(*anchor_ms, "anchor") {
                    Ok(anchor) => format!(
                        "every {}s from {}",
                        Self::every_ms_to_seconds(*every_ms),
                        anchor
                    ),
                    Err(_) => format!("every {}s", Self::every_ms_to_seconds(*every_ms)),
                },
                None => format!("every {}s", Self::every_ms_to_seconds(*every_ms)),
            },
            CronSchedule::Cron { expr, tz } => match tz.as_deref() {
                Some(tz) if !tz.trim().is_empty() => format!("cron {} ({})", expr, tz),
                _ => format!("cron {} (local timezone)", expr),
            },
        }
    }

    fn build_list_result_for_assistant(
        &self,
        workspace: &str,
        session_id: &str,
        jobs: &[CronJob],
    ) -> String {
        if jobs.is_empty() {
            return format!(
                "No scheduled jobs found for session '{}' in workspace '{}'.",
                session_id, workspace
            );
        }

        let mut lines = vec![format!(
            "Found {} scheduled job(s) for session '{}' in workspace '{}'.",
            jobs.len(),
            session_id,
            workspace,
        )];
        lines.push(String::new());
        lines.push("| job_id | name | enabled | schedule |".to_string());
        lines.push("| --- | --- | --- | --- |".to_string());
        for job in jobs {
            lines.push(format!(
                "| {} | {} | {} | {} |",
                Self::escape_markdown_table_cell(&job.id),
                Self::escape_markdown_table_cell(&job.name),
                if job.enabled { "true" } else { "false" },
                Self::escape_markdown_table_cell(&Self::schedule_summary(&job.schedule)),
            ));
        }
        lines.join("\n")
    }
}

impl Default for CronTool {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CronAction {
    GetTime,
    List,
    Add,
    Update,
    Remove,
    Run,
}

#[derive(Debug, Clone, Deserialize)]
struct CronToolJobInput {
    name: Option<String>,
    schedule: CronToolScheduleInput,
    payload: String,
    enabled: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct CronToolJobPatchInput {
    name: Option<String>,
    schedule: Option<CronToolScheduleInput>,
    payload: Option<String>,
    enabled: Option<bool>,
}

impl CronToolJobPatchInput {
    fn is_empty(&self) -> bool {
        self.name.is_none()
            && self.schedule.is_none()
            && self.payload.is_none()
            && self.enabled.is_none()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
struct CronToolInput {
    action: CronAction,
    session_id: Option<String>,
    job: Option<CronToolJobInput>,
    patch: Option<CronToolJobPatchInput>,
    job_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CronToolScheduleInput {
    At { at: String },
    Every { every: u64, anchor: Option<String> },
    Cron { expr: String, tz: Option<String> },
}

impl CronToolScheduleInput {
    fn to_service_schedule(&self, field_name: &str) -> OpenBitFunResult<CronSchedule> {
        match self {
            Self::At { at } => {
                let at = at.trim();
                if at.is_empty() {
                    return Err(OpenBitFunError::tool(format!(
                        "{}.at cannot be empty",
                        field_name
                    )));
                }
                CronTool::parse_iso_timestamp_ms(at, &format!("{}.at", field_name))?;
                Ok(CronSchedule::At { at: at.to_string() })
            }
            Self::Every { every, anchor } => {
                let anchor_ms = match anchor.as_deref() {
                    Some(anchor) if anchor.trim().is_empty() => {
                        return Err(OpenBitFunError::tool(format!(
                            "{}.anchor cannot be empty when provided",
                            field_name
                        )));
                    }
                    Some(anchor) => Some(CronTool::parse_iso_timestamp_ms(
                        anchor.trim(),
                        &format!("{}.anchor", field_name),
                    )?),
                    None => None,
                };

                Ok(CronSchedule::Every {
                    every_ms: CronTool::seconds_to_every_ms(*every, field_name)?,
                    anchor_ms,
                })
            }
            Self::Cron { expr, tz } => {
                let expr = expr.trim();
                if expr.is_empty() {
                    return Err(OpenBitFunError::tool(format!(
                        "{}.expr cannot be empty",
                        field_name
                    )));
                }

                Ok(CronSchedule::Cron {
                    expr: expr.to_string(),
                    tz: tz
                        .as_ref()
                        .map(|value| value.trim().to_string())
                        .filter(|value| !value.is_empty()),
                })
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum CronToolScheduleOutput {
    At {
        at: String,
    },
    Every {
        every: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        anchor: Option<String>,
    },
    Cron {
        expr: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
}

impl TryFrom<&CronSchedule> for CronToolScheduleOutput {
    type Error = OpenBitFunError;

    fn try_from(schedule: &CronSchedule) -> OpenBitFunResult<Self> {
        match schedule {
            CronSchedule::At { at } => Ok(Self::At { at: at.clone() }),
            CronSchedule::Every {
                every_ms,
                anchor_ms,
            } => Ok(Self::Every {
                every: CronTool::every_ms_to_seconds(*every_ms),
                anchor: anchor_ms
                    .map(|value| CronTool::format_iso_timestamp_local(value, "anchor"))
                    .transpose()?,
            }),
            CronSchedule::Cron { expr, tz } => Ok(Self::Cron {
                expr: expr.clone(),
                tz: tz.clone(),
            }),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronToolJobStateOutput {
    next_run_at_ms: Option<i64>,
    pending_trigger_at_ms: Option<i64>,
    retry_at_ms: Option<i64>,
    last_trigger_at_ms: Option<i64>,
    last_enqueued_at_ms: Option<i64>,
    last_run_started_at_ms: Option<i64>,
    last_run_finished_at_ms: Option<i64>,
    last_duration_ms: Option<u64>,
    last_run_status: Option<CronJobRunStatus>,
    last_error: Option<String>,
    active_turn_id: Option<String>,
    consecutive_failures: u32,
    coalesced_run_count: u32,
}

impl From<&crate::service::cron::CronJobState> for CronToolJobStateOutput {
    fn from(state: &crate::service::cron::CronJobState) -> Self {
        Self {
            next_run_at_ms: state.next_run_at_ms,
            pending_trigger_at_ms: state.pending_trigger_at_ms,
            retry_at_ms: state.retry_at_ms,
            last_trigger_at_ms: state.last_trigger_at_ms,
            last_enqueued_at_ms: state.last_enqueued_at_ms,
            last_run_started_at_ms: state.last_run_started_at_ms,
            last_run_finished_at_ms: state.last_run_finished_at_ms,
            last_duration_ms: state.last_duration_ms,
            last_run_status: state.last_run_status,
            last_error: state.last_error.clone(),
            active_turn_id: state.active_turn_id.clone(),
            consecutive_failures: state.consecutive_failures,
            coalesced_run_count: state.coalesced_run_count,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CronToolJobOutput {
    id: String,
    name: String,
    schedule: CronToolScheduleOutput,
    payload: String,
    enabled: bool,
    session_id: String,
    workspace_path: String,
    created_at_ms: i64,
    config_updated_at_ms: i64,
    updated_at_ms: i64,
    state: CronToolJobStateOutput,
}

impl TryFrom<&CronJob> for CronToolJobOutput {
    type Error = OpenBitFunError;

    fn try_from(job: &CronJob) -> OpenBitFunResult<Self> {
        Ok(Self {
            id: job.id.clone(),
            name: job.name.clone(),
            schedule: CronToolScheduleOutput::try_from(&job.schedule)?,
            payload: job.payload.text.clone(),
            enabled: job.enabled,
            session_id: job.session_id().unwrap_or_default().to_string(),
            workspace_path: job.workspace().workspace_path.clone(),
            created_at_ms: job.created_at_ms,
            config_updated_at_ms: job.config_updated_at_ms,
            updated_at_ms: job.updated_at_ms,
            state: CronToolJobStateOutput::from(&job.state),
        })
    }
}

#[async_trait]
impl Tool for CronTool {
    fn name(&self) -> &str {
        "Cron"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r#"Manage scheduled jobs.

Scheduling is a handoff, not a step:
- Creating a job does NOT end the current turn. No tool can end a turn — only you can, by stopping.
- After scheduling a repeating job for this session, finish what is already in flight and then end your turn. Do not start the next round yourself and do not wait for it.
- A job delivers its payload to the target session as a new user message when it fires; that message is what starts the next round.
- A run that fires while the session is still busy is queued, never run in parallel, so a turn that outlives the interval only makes the next round start late. Pick an interval comfortably longer than one round takes.

Defaults:
- "session_id": defaults to the current session for "list" and "add".

Actions:
- "get_time": Return the current local time including timezone information.
- "list": List all jobs for the effective session scope.
- "add": Create a job. Requires "job". When "job.name" is omitted, uses "Cron job".
- "update": Update a job. Requires "job_id" and "patch".
- "remove": Delete a job. Requires "job_id".
- "run": Trigger a job immediately. Requires "job_id".

Job schema for "add":
{
  "name": "string (optional)",
  "schedule": { ... },
  "payload": "string (sent to the target session as a user message)",
  "enabled": true | false
}

Schedule schema:
- One-shot at absolute time:
  { "kind": "at", "at": "2026-03-17T12:00:00+08:00" }
- Recurring interval:
  { "kind": "every", "every": 3600, "anchor": "2026-03-17T12:00:00+08:00" }
  - "every" is in seconds.
  - "anchor" is optional and uses the same ISO-8601 format as "at". Defaults to the current time.
- Cron expression:
  { "kind": "cron", "expr": "0 9 * * 1-5", "tz": "Asia/Shanghai" }
  - "tz" is optional. Defaults to the local timezone.

Patch schema for "update":
- Same fields as "job", but every field is optional."#
            .to_string())
    }

    fn short_description(&self) -> String {
        "Manage scheduled jobs.".to_string()
    }

    fn default_exposure(&self) -> ToolExposure {
        ToolExposure::Deferred
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "session_id": {
                    "type": "string",
                    "description": "Optional target session ID. Defaults to the current session for list/add."
                },
                "action": {
                    "type": "string",
                    "enum": ["get_time", "list", "add", "update", "remove", "run"],
                    "description": "Cron action to perform."
                },
                "job": {
                    "type": "object",
                    "description": "Required for add.",
                    "properties": {
                        "name": {
                            "type": "string",
                            "description": "Optional job name. Defaults to 'Cron job'."
                        },
                        "schedule": {
                            "type": "object",
                            "description": "Required schedule definition. Use { \"kind\": \"at\", \"at\": \"<ISO-8601>\" }, { \"kind\": \"every\", \"every\": <seconds>, \"anchor\": \"<optional ISO-8601>\" }, or { \"kind\": \"cron\", \"expr\": \"<cron-expression>\", \"tz\": \"<optional timezone>\" }. anchor defaults to the current time. tz defaults to the local timezone."
                        },
                        "payload": {
                            "type": "string",
                            "description": "Required execution payload text. It will be sent to the target session as a user message."
                        },
                        "enabled": {
                            "type": "boolean",
                            "description": "Optional enabled flag. Defaults to true."
                        }
                    },
                    "required": ["schedule", "payload"],
                    "additionalProperties": false
                },
                "patch": {
                    "type": "object",
                    "description": "Required for update. Same fields as job, but all optional.",
                    "properties": {
                        "name": {
                            "type": "string"
                        },
                        "schedule": {
                            "type": "object"
                        },
                        "payload": {
                            "type": "string",
                            "description": "Optional updated payload text. It will be sent to the target session as a user message."
                        },
                        "enabled": {
                            "type": "boolean"
                        }
                    },
                    "additionalProperties": false
                },
                "job_id": {
                    "type": "string",
                    "description": "Required for update, remove, and run."
                }
            },
            "required": ["action"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        let Some(input) = input else {
            return false;
        };
        let Some(action) = input.get("action").and_then(|value| value.as_str()) else {
            return false;
        };
        matches!(action, "get_time" | "list")
    }

    async fn validate_input(
        &self,
        input: &Value,
        context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        let parsed: CronToolInput = match serde_json::from_value(input.clone()) {
            Ok(value) => value,
            Err(err) => {
                return ValidationResult {
                    result: false,
                    message: Some(format!("Invalid input: {}", err)),
                    error_code: Some(400),
                    meta: None,
                };
            }
        };

        if let Some(session_id) = parsed.session_id.as_deref() {
            if let Err(message) = Self::validate_session_id(session_id.trim()) {
                return ValidationResult {
                    result: false,
                    message: Some(message),
                    error_code: Some(400),
                    meta: None,
                };
            }
        }

        match parsed.action {
            CronAction::GetTime => ValidationResult::default(),
            CronAction::List => {
                let has_effective_session = parsed.session_id.is_some()
                    || context
                        .and_then(|tool_context| tool_context.session_id.as_deref())
                        .is_some();
                if !has_effective_session {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "session_id is required for list when the current session is unavailable"
                                .to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                if parsed.session_id.is_none()
                    && context
                        .and_then(|tool_context| tool_context.workspace_root())
                        .is_none()
                {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "the current workspace is required for list when session_id is omitted"
                                .to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                ValidationResult::default()
            }
            CronAction::Add => {
                let Some(job) = parsed.job.as_ref() else {
                    return ValidationResult {
                        result: false,
                        message: Some("job is required for add".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                };

                if let Err(error) = Self::validate_payload(&job.payload, "job") {
                    return ValidationResult {
                        result: false,
                        message: Some(error.to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                if let Err(error) = job.schedule.to_service_schedule("job.schedule") {
                    return ValidationResult {
                        result: false,
                        message: Some(error.to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                let has_effective_session = parsed.session_id.is_some()
                    || context
                        .and_then(|tool_context| tool_context.session_id.as_deref())
                        .is_some();
                if !has_effective_session {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "session_id is required for add when the current session is unavailable"
                                .to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                if parsed.session_id.is_none()
                    && context
                        .and_then(|tool_context| tool_context.workspace_root())
                        .is_none()
                {
                    return ValidationResult {
                        result: false,
                        message: Some(
                            "the current workspace is required for add when session_id is omitted"
                                .to_string(),
                        ),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                ValidationResult::default()
            }
            CronAction::Update => {
                let Some(job_id) = parsed.job_id.as_deref() else {
                    return ValidationResult {
                        result: false,
                        message: Some("job_id is required for update".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                };
                if let Err(message) = Self::validate_job_id(job_id) {
                    return ValidationResult {
                        result: false,
                        message: Some(message),
                        error_code: Some(400),
                        meta: None,
                    };
                }

                let Some(patch) = parsed.patch.as_ref() else {
                    return ValidationResult {
                        result: false,
                        message: Some("patch is required for update".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                };
                if patch.is_empty() {
                    return ValidationResult {
                        result: false,
                        message: Some("patch must include at least one field".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                if let Some(name) = patch.name.as_deref() {
                    if name.trim().is_empty() {
                        return ValidationResult {
                            result: false,
                            message: Some("patch.name cannot be empty when provided".to_string()),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                }
                if let Some(payload) = patch.payload.as_ref() {
                    if let Err(error) = Self::validate_payload(payload, "patch") {
                        return ValidationResult {
                            result: false,
                            message: Some(error.to_string()),
                            error_code: Some(400),
                            meta: None,
                        };
                    };
                }
                if let Some(schedule) = patch.schedule.as_ref() {
                    if let Err(error) = schedule.to_service_schedule("patch.schedule") {
                        return ValidationResult {
                            result: false,
                            message: Some(error.to_string()),
                            error_code: Some(400),
                            meta: None,
                        };
                    }
                }
                ValidationResult::default()
            }
            CronAction::Remove => {
                let Some(job_id) = parsed.job_id.as_deref() else {
                    return ValidationResult {
                        result: false,
                        message: Some("job_id is required for remove".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                };
                if let Err(message) = Self::validate_job_id(job_id) {
                    return ValidationResult {
                        result: false,
                        message: Some(message),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                ValidationResult::default()
            }
            CronAction::Run => {
                let Some(job_id) = parsed.job_id.as_deref() else {
                    return ValidationResult {
                        result: false,
                        message: Some("job_id is required for run".to_string()),
                        error_code: Some(400),
                        meta: None,
                    };
                };
                if let Err(message) = Self::validate_job_id(job_id) {
                    return ValidationResult {
                        result: false,
                        message: Some(message),
                        error_code: Some(400),
                        meta: None,
                    };
                }
                ValidationResult::default()
            }
        }
    }

    fn render_tool_use_message(&self, input: &Value, _options: &ToolRenderOptions) -> String {
        let action = input
            .get("action")
            .and_then(|value| value.as_str())
            .unwrap_or("unknown");
        let job_id = input
            .get("job_id")
            .and_then(|value| value.as_str())
            .unwrap_or("auto");

        match action {
            "get_time" => "Get current ISO-8601 time".to_string(),
            "list" => "List scheduled jobs".to_string(),
            "add" => "Create scheduled job".to_string(),
            "update" => format!("Update scheduled job {}", job_id),
            "remove" => format!("Delete scheduled job {}", job_id),
            "run" => format!("Run scheduled job {}", job_id),
            _ => "Manage scheduled jobs".to_string(),
        }
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let params: CronToolInput = serde_json::from_value(input.clone())
            .map_err(|err| OpenBitFunError::tool(format!("Invalid input: {}", err)))?;

        match params.action {
            CronAction::GetTime => {
                let now = Local::now();
                let iso = now.to_rfc3339_opts(SecondsFormat::Secs, false);
                let result_for_assistant = format!("Current local time: {}", iso);

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "get_time",
                        "now": iso,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            CronAction::List => {
                let cron_service = get_global_cron_service().ok_or_else(|| {
                    OpenBitFunError::tool("cron service not initialized".to_string())
                })?;
                let session_id =
                    self.resolve_effective_session_id(params.session_id.as_deref(), context)?;
                let workspace_ref = self
                    .resolve_effective_workspace_for_session(&session_id, context)
                    .await?;
                let workspace = workspace_ref.workspace_path.clone();
                let mut jobs = cron_service
                    .list_jobs_filtered(
                        workspace_ref.workspace_id.as_deref(),
                        Some(&session_id),
                        Some(CronJobTargetKind::Session),
                    )
                    .await;
                jobs.sort_by(|left, right| {
                    left.created_at_ms
                        .cmp(&right.created_at_ms)
                        .then_with(|| left.id.cmp(&right.id))
                });
                let serialized_jobs = Self::serialize_jobs(&jobs)?;

                let result_for_assistant =
                    self.build_list_result_for_assistant(&workspace, &session_id, &jobs);

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "list",
                        "workspace": workspace,
                        "session_id": session_id,
                        "count": jobs.len(),
                        "jobs": serialized_jobs,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            CronAction::Add => {
                let cron_service = get_global_cron_service().ok_or_else(|| {
                    OpenBitFunError::tool("cron service not initialized".to_string())
                })?;
                let session_id =
                    self.resolve_effective_session_id(params.session_id.as_deref(), context)?;
                let workspace_ref = self
                    .resolve_effective_workspace_for_session(&session_id, context)
                    .await?;
                let workspace = workspace_ref.workspace_path.clone();
                let job = params
                    .job
                    .ok_or_else(|| OpenBitFunError::tool("job is required for add".to_string()))?;

                Self::validate_payload(&job.payload, "job")?;

                let created = cron_service
                    .create_job(CreateCronJobRequest {
                        name: Self::normalize_add_name(job.name),
                        schedule: job.schedule.to_service_schedule("job.schedule")?,
                        payload: Self::into_service_payload(job.payload),
                        enabled: job.enabled.unwrap_or(true),
                        target: CronJobTarget::Session {
                            session_id: session_id.clone(),
                            workspace: workspace_ref,
                        },
                    })
                    .await?;
                let serialized_job = Self::serialize_job(&created)?;
                let result_for_assistant =
                    Self::add_result_summary(&created, context.session_id.as_deref());

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "add",
                        "workspace": workspace,
                        "session_id": session_id,
                        "job": serialized_job,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            CronAction::Update => {
                let cron_service = get_global_cron_service().ok_or_else(|| {
                    OpenBitFunError::tool("cron service not initialized".to_string())
                })?;
                let job_id = params.job_id.ok_or_else(|| {
                    OpenBitFunError::tool("job_id is required for update".to_string())
                })?;
                Self::validate_job_id(&job_id).map_err(OpenBitFunError::tool)?;
                let patch = params.patch.ok_or_else(|| {
                    OpenBitFunError::tool("patch is required for update".to_string())
                })?;
                if patch.is_empty() {
                    return Err(OpenBitFunError::tool(
                        "patch must include at least one field".to_string(),
                    ));
                }
                if let Some(payload) = patch.payload.as_ref() {
                    Self::validate_payload(payload, "patch")?;
                }

                let updated = cron_service
                    .update_job(
                        &job_id,
                        UpdateCronJobRequest {
                            name: Self::normalize_optional_name(patch.name)?,
                            schedule: patch
                                .schedule
                                .as_ref()
                                .map(|value| value.to_service_schedule("patch.schedule"))
                                .transpose()?,
                            payload: patch.payload.map(Self::into_service_payload),
                            enabled: patch.enabled,
                            target: None,
                        },
                    )
                    .await?;
                let serialized_job = Self::serialize_job(&updated)?;
                let result_for_assistant =
                    format!("Updated scheduled job '{}' ({})", updated.name, updated.id);

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "update",
                        "job_id": job_id,
                        "job": serialized_job,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            CronAction::Remove => {
                let cron_service = get_global_cron_service().ok_or_else(|| {
                    OpenBitFunError::tool("cron service not initialized".to_string())
                })?;
                let job_id = params.job_id.ok_or_else(|| {
                    OpenBitFunError::tool("job_id is required for remove".to_string())
                })?;
                Self::validate_job_id(&job_id).map_err(OpenBitFunError::tool)?;

                let deleted = cron_service.delete_job(&job_id).await?;
                let result_for_assistant = if deleted {
                    format!("Deleted scheduled job '{}'.", job_id)
                } else {
                    format!("No scheduled job found for '{}'.", job_id)
                };

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "remove",
                        "job_id": job_id,
                        "deleted": deleted,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
            CronAction::Run => {
                let cron_service = get_global_cron_service().ok_or_else(|| {
                    OpenBitFunError::tool("cron service not initialized".to_string())
                })?;
                let job_id = params.job_id.ok_or_else(|| {
                    OpenBitFunError::tool("job_id is required for run".to_string())
                })?;
                Self::validate_job_id(&job_id).map_err(OpenBitFunError::tool)?;

                let updated = cron_service.run_job_now(&job_id).await?;
                let serialized_job = Self::serialize_job(&updated)?;
                let result_for_assistant = format!(
                    "Triggered scheduled job '{}' ({}) for immediate execution.",
                    updated.name, updated.id
                );

                Ok(vec![ToolResult::Result {
                    data: json!({
                        "success": true,
                        "action": "run",
                        "job_id": job_id,
                        "job": serialized_job,
                    }),
                    result_for_assistant: Some(result_for_assistant),
                    image_attachments: None,
                }])
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agentic::tools::framework::ToolUseContext;
    use crate::agentic::workspace::WorkspaceBinding;
    use crate::service::remote_ssh::workspace_state::workspace_session_identity;
    use serde_json::json;
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn empty_context() -> ToolUseContext {
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: None,
            dialog_turn_id: None,
            workspace: None,
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    fn remote_context(
        root: &str,
        workspace_id: Option<String>,
        session_id: Option<&str>,
    ) -> ToolUseContext {
        let session_identity = workspace_session_identity(root, Some("conn-1"), Some("ssh.dev"))
            .expect("remote identity");
        ToolUseContext {
            tool_call_id: None,
            agent_type: None,
            session_id: session_id.map(ToOwned::to_owned),
            dialog_turn_id: None,
            workspace: Some(WorkspaceBinding::new_remote(
                workspace_id,
                PathBuf::from(root),
                "conn-1".to_string(),
                "Dev SSH".to_string(),
                session_identity,
            )),
            loaded_deferred_tool_specs: Vec::new(),
            primary_model_facts: tool_runtime::context::PrimaryModelFacts::default(),
            custom_data: HashMap::new(),
            computer_use_host: None,
            runtime_tool_restrictions: Default::default(),
            runtime_handles: openbitfun_runtime_ports::ToolRuntimeHandles::default(),
        }
    }

    #[tokio::test]
    async fn validate_list_allows_missing_workspace_when_session_id_present() {
        let tool = CronTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "list",
                    "session_id": "worker_1",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(validation.result, "{:?}", validation.message);
    }

    #[tokio::test]
    async fn validate_add_allows_missing_workspace_when_session_id_present() {
        let tool = CronTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "add",
                    "session_id": "worker_1",
                    "job": {
                        "payload": "hello",
                        "schedule": {
                            "kind": "every",
                            "every": 60
                        }
                    }
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(validation.result, "{:?}", validation.message);
    }

    #[tokio::test]
    async fn validate_rejects_legacy_workspace_field() {
        let tool = CronTool::new();

        let validation = tool
            .validate_input(
                &json!({
                    "action": "list",
                    "session_id": "worker_1",
                    "workspace": "E:/Projects/OpenBitFun/OpenBitFun",
                }),
                Some(&empty_context()),
            )
            .await;

        assert!(!validation.result);
        assert!(validation
            .message
            .as_deref()
            .unwrap_or_default()
            .contains("unknown field"));
    }

    #[test]
    fn workspace_ref_from_context_binding_uses_remote_context_identity() {
        let context = remote_context(
            "/home/wsp/projects/test",
            Some("remote_workspace_1".to_string()),
            Some("session-1"),
        );

        let workspace_ref = CronTool::workspace_ref_from_context_binding(
            context.workspace.as_ref().expect("workspace binding"),
        );

        assert_eq!(
            workspace_ref.workspace_id.as_deref(),
            Some("remote_workspace_1")
        );
        assert_eq!(workspace_ref.workspace_path, "/home/wsp/projects/test");
        assert_eq!(
            workspace_ref.remote_connection_id.as_deref(),
            Some("conn-1")
        );
        assert_eq!(workspace_ref.remote_ssh_host.as_deref(), Some("ssh.dev"));
    }

    #[test]
    fn workspace_ref_from_agent_binding_preserves_full_workspace_identity() {
        let workspace_ref =
            CronTool::workspace_ref_from_agent_binding(AgentSessionWorkspaceBinding {
                workspace_kind: None,
                project_workspace_id: None,
                workspace_id: Some("workspace-1".to_string()),
                workspace_path: "/home/wsp/projects/test".to_string(),
                project_workspace_path: None,
                execution_target: None,
                remote_connection_id: Some("conn-1".to_string()),
                remote_ssh_host: Some("ssh.dev".to_string()),
            });

        assert_eq!(workspace_ref.workspace_id.as_deref(), Some("workspace-1"));
        assert_eq!(workspace_ref.workspace_path, "/home/wsp/projects/test");
        assert_eq!(
            workspace_ref.remote_connection_id.as_deref(),
            Some("conn-1")
        );
        assert_eq!(workspace_ref.remote_ssh_host.as_deref(), Some("ssh.dev"));
    }

    fn job_with_schedule(schedule: CronSchedule, session_id: &str) -> CronJob {
        CronJob {
            id: "cron_4d437971".to_string(),
            name: "round every 30min".to_string(),
            schedule,
            payload: CronJobPayload {
                text: "run the next round".to_string(),
            },
            enabled: true,
            target: CronJobTarget::Session {
                session_id: session_id.to_string(),
                workspace: CronWorkspaceRef {
                    workspace_id: None,
                    workspace_path: "/home/wsp/projects/test".to_string(),
                    project_workspace_path: None,
                    execution_target: None,
                    remote_connection_id: None,
                    remote_ssh_host: None,
                },
            },
            created_at_ms: 0,
            config_updated_at_ms: 0,
            updated_at_ms: 0,
            state: Default::default(),
        }
    }

    fn every_30_minutes() -> CronSchedule {
        CronSchedule::Every {
            every_ms: 30 * 60 * 1_000,
            anchor_ms: None,
        }
    }

    #[test]
    fn a_recurring_job_for_this_session_tells_the_agent_to_end_its_turn() {
        // Without this, `add` reads as an ordinary success and the agent keeps
        // driving the loop it just handed to the scheduler — the round then
        // outruns the interval and delays the trigger it is racing.
        let summary = CronTool::add_result_summary(
            &job_with_schedule(every_30_minutes(), "session_1"),
            Some("session_1"),
        );

        assert!(summary.contains("cron_4d437971"), "got: {summary}");
        assert!(summary.contains("end your turn"), "got: {summary}");
        // The turn does not end by itself, and the guidance has to say so:
        // no tool can end a turn, only the model choosing to stop.
        assert!(summary.contains("did not end your turn"), "got: {summary}");
    }

    #[test]
    fn a_cron_expression_schedule_also_hands_over_the_cadence() {
        let summary = CronTool::add_result_summary(
            &job_with_schedule(
                CronSchedule::Cron {
                    expr: "0 9 * * 1-5".to_string(),
                    tz: None,
                },
                "session_1",
            ),
            Some("session_1"),
        );

        assert!(summary.contains("end your turn"), "got: {summary}");
    }

    #[test]
    fn a_one_shot_job_leaves_the_current_turn_alone() {
        // A single reminder says nothing about what to do with the rest of the
        // turn, so telling the agent to stop would cut real work short.
        let summary = CronTool::add_result_summary(
            &job_with_schedule(
                CronSchedule::At {
                    at: "2026-03-17T12:00:00+08:00".to_string(),
                },
                "session_1",
            ),
            Some("session_1"),
        );

        assert!(!summary.contains("end your turn"), "got: {summary}");
    }

    #[test]
    fn scheduling_work_for_another_session_leaves_the_current_turn_alone() {
        // The cadence being handed over is not this turn's, so this agent has
        // no reason to stop what it is doing.
        let summary = CronTool::add_result_summary(
            &job_with_schedule(every_30_minutes(), "session_other"),
            Some("session_1"),
        );

        assert!(!summary.contains("end your turn"), "got: {summary}");

        // Same when the caller has no session identity to compare against.
        let summary =
            CronTool::add_result_summary(&job_with_schedule(every_30_minutes(), "session_1"), None);
        assert!(!summary.contains("end your turn"), "got: {summary}");
    }
}
