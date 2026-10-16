//! Scheduled job data types.

use openbitfun_agent_runtime::scheduled_job::DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS;
pub use openbitfun_agent_runtime::scheduled_job::{
    ScheduledJobRunStatus as CronJobRunStatus, ScheduledJobRuntimeState as CronJobState,
};
use openbitfun_core_types::SessionExecutionTarget;
use serde::{Deserialize, Serialize};

pub const CRON_JOBS_VERSION: u32 = 2;

pub const DEFAULT_RETRY_DELAY_MS: i64 = DEFAULT_SCHEDULED_JOB_RETRY_DELAY_MS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobsFile {
    pub version: u32,
    pub jobs: Vec<CronJob>,
}

impl Default for CronJobsFile {
    fn default() -> Self {
        Self {
            version: CRON_JOBS_VERSION,
            jobs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJob {
    pub id: String,
    pub name: String,
    pub schedule: CronSchedule,
    pub payload: CronJobPayload,
    #[serde(default)]
    pub report_policy: openbitfun_core_types::background_delivery::BackgroundReportPolicy,
    pub enabled: bool,
    pub target: CronJobTarget,
    pub created_at_ms: i64,
    pub config_updated_at_ms: i64,
    pub updated_at_ms: i64,
    #[serde(default)]
    pub state: CronJobState,
}

impl CronJob {
    pub fn is_one_shot(&self) -> bool {
        matches!(self.schedule, CronSchedule::At { .. })
    }

    pub fn target_kind(&self) -> CronJobTargetKind {
        self.target.kind()
    }

    pub fn workspace(&self) -> &CronWorkspaceRef {
        self.target.workspace()
    }

    pub fn session_id(&self) -> Option<&str> {
        self.target.session_id()
    }

    pub fn launch(&self) -> Option<&CronLaunchSpec> {
        self.target.launch()
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CronJobTargetKind {
    Session,
    Workspace,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronWorkspaceRef {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    /// IO projection retained for old readers; never a workspace key.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub workspace_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project_workspace_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_target: Option<SessionExecutionTarget>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_connection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_ssh_host: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronLaunchSpec {
    #[serde(default = "default_agent_type")]
    pub agent_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_id: Option<String>,
}

impl Default for CronLaunchSpec {
    fn default() -> Self {
        Self {
            agent_type: default_agent_type(),
            model_id: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CronJobTarget {
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
        workspace: CronWorkspaceRef,
    },
    Workspace {
        workspace: CronWorkspaceRef,
        #[serde(default)]
        launch: CronLaunchSpec,
    },
}

impl CronJobTarget {
    pub fn kind(&self) -> CronJobTargetKind {
        match self {
            Self::Session { .. } => CronJobTargetKind::Session,
            Self::Workspace { .. } => CronJobTargetKind::Workspace,
        }
    }

    pub fn workspace(&self) -> &CronWorkspaceRef {
        match self {
            Self::Session { workspace, .. } | Self::Workspace { workspace, .. } => workspace,
        }
    }

    pub fn session_id(&self) -> Option<&str> {
        match self {
            Self::Session { session_id, .. } => Some(session_id.as_str()),
            Self::Workspace { .. } => None,
        }
    }

    pub fn launch(&self) -> Option<&CronLaunchSpec> {
        match self {
            Self::Session { .. } => None,
            Self::Workspace { launch, .. } => Some(launch),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CronSchedule {
    At {
        at: String,
    },
    Every {
        #[serde(rename = "everyMs")]
        every_ms: u64,
        #[serde(rename = "anchorMs", skip_serializing_if = "Option::is_none")]
        anchor_ms: Option<i64>,
    },
    Cron {
        expr: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CronJobPayload {
    pub text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateCronJobRequest {
    pub name: String,
    pub schedule: CronSchedule,
    pub payload: CronJobPayload,
    #[serde(default)]
    pub report_policy: openbitfun_core_types::background_delivery::BackgroundReportPolicy,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub target: CronJobTarget,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCronJobRequest {
    pub name: Option<String>,
    pub schedule: Option<CronSchedule>,
    pub payload: Option<CronJobPayload>,
    #[serde(default)]
    pub report_policy: Option<openbitfun_core_types::background_delivery::BackgroundReportPolicy>,
    pub enabled: Option<bool>,
    pub target: Option<CronJobTarget>,
}

const fn default_enabled() -> bool {
    true
}

fn default_agent_type() -> String {
    "Standard".to_string()
}

#[cfg(test)]
mod background_delivery_upgrade_tests {
    use super::*;
    use openbitfun_core_types::background_delivery::BackgroundReportPolicy;
    use serde_json::json;

    #[test]
    fn legacy_jobs_and_requests_inherit_instructions_without_repair() {
        let request = json!({
            "name":"Generic monitor", "schedule":{"kind":"every","everyMs":60000},
            "payload":{"text":"Report changes only."},
            "target":{"kind":"session","sessionId":"session","workspace":{"workspacePath":"/workspace"}}
        });
        let create: CreateCronJobRequest = serde_json::from_value(request.clone()).unwrap();
        assert_eq!(create.report_policy, BackgroundReportPolicy::Inherit);
        let mut saved = request;
        saved["id"] = json!("job");
        saved["createdAtMs"] = json!(1);
        saved["updatedAtMs"] = json!(1);
        saved["configUpdatedAtMs"] = json!(1);
        saved["enabled"] = json!(true);
        let job: CronJob = serde_json::from_value(saved).unwrap();
        let round_trip: CronJob =
            serde_json::from_value(serde_json::to_value(&job).unwrap()).unwrap();
        assert_eq!(job, round_trip);
        let patch: UpdateCronJobRequest =
            serde_json::from_value(json!({"name":"Renamed"})).unwrap();
        assert!(patch.report_policy.is_none());
        let mut future = serde_json::to_value(&job).unwrap();
        future["reportPolicy"] = json!("future_policy");
        let future: CronJob = serde_json::from_value(future).unwrap();
        assert_eq!(
            future.report_policy,
            BackgroundReportPolicy::Unknown("future_policy".into())
        );
        assert_eq!(
            serde_json::to_value(&future).unwrap()["reportPolicy"],
            "future_policy"
        );
        assert_eq!(future.payload, job.payload);
    }
}
