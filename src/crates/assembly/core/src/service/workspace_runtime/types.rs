use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const WORKSPACE_RUNTIME_LAYOUT_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum WorkspaceRuntimeTarget {
    LocalWorkspace {
        workspace_root: PathBuf,
    },
    RemoteWorkspaceMirror {
        ssh_host: String,
        remote_root: String,
    },
}

impl WorkspaceRuntimeTarget {
    pub fn kind(&self) -> &'static str {
        match self {
            Self::LocalWorkspace { .. } => "local_workspace",
            Self::RemoteWorkspaceMirror { .. } => "remote_workspace_mirror",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRuntimeContext {
    pub target: WorkspaceRuntimeTarget,
    pub runtime_root: PathBuf,
    pub sessions_dir: PathBuf,
    pub request_traces_dir: PathBuf,
    pub snapshots_dir: PathBuf,
    pub snapshot_by_hash_dir: PathBuf,
    pub snapshot_metadata_dir: PathBuf,
    pub snapshot_baselines_dir: PathBuf,
    pub snapshot_operations_dir: PathBuf,
    pub locks_dir: PathBuf,
    pub config_dir: PathBuf,
    pub isolation_status_file: PathBuf,
    pub layout_state_file: PathBuf,
}

impl WorkspaceRuntimeContext {
    pub fn new(target: WorkspaceRuntimeTarget, runtime_root: PathBuf) -> Self {
        let snapshots_dir = runtime_root.join("snapshots");
        let config_dir = runtime_root.join("config");

        Self {
            target,
            sessions_dir: runtime_root.join("sessions"),
            request_traces_dir: runtime_root.join("request-traces"),
            snapshot_by_hash_dir: snapshots_dir.join("by_hash"),
            snapshot_metadata_dir: snapshots_dir.join("metadata"),
            snapshot_baselines_dir: snapshots_dir.join("baselines"),
            snapshot_operations_dir: snapshots_dir.join("operations"),
            locks_dir: runtime_root.join("locks"),
            isolation_status_file: config_dir.join("isolation_status.json"),
            layout_state_file: config_dir.join("runtime_layout_state.json"),
            runtime_root,
            snapshots_dir,
            config_dir,
        }
    }

    pub fn required_directories(&self) -> Vec<&Path> {
        vec![
            self.runtime_root.as_path(),
            self.sessions_dir.as_path(),
            self.request_traces_dir.as_path(),
            self.snapshots_dir.as_path(),
            self.snapshot_by_hash_dir.as_path(),
            self.snapshot_metadata_dir.as_path(),
            self.snapshot_baselines_dir.as_path(),
            self.snapshot_operations_dir.as_path(),
            self.locks_dir.as_path(),
            self.config_dir.as_path(),
        ]
    }

    pub fn session_dir(&self, session_id: &str) -> PathBuf {
        self.sessions_dir.join(session_id)
    }

    pub fn session_tool_results_dir(&self, session_id: &str) -> PathBuf {
        self.session_dir(session_id).join("tool-results")
    }

    pub fn session_tool_result_path(&self, session_id: &str, file_name: &str) -> PathBuf {
        self.session_tool_results_dir(session_id).join(file_name)
    }

    pub fn request_trace_session_dir(&self, session_id: &str) -> PathBuf {
        self.request_traces_dir.join(session_id)
    }

    pub fn request_trace_path(&self, session_id: &str, sequence: u64) -> PathBuf {
        self.request_trace_session_dir(session_id)
            .join(format!("request-{:06}.json", sequence))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceRuntimeEnsureResult {
    pub context: WorkspaceRuntimeContext,
    pub created_directories: Vec<PathBuf>,
}
