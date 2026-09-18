use serde::{Deserialize, Serialize};

/// Workspace lifecycle kind.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceKind {
    #[default]
    Normal,
    Assistant,
    Remote,
}
