use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
pub use openbitfun_agent_tools::{
    is_miniapp_headless_agent_run, is_miniapp_market_strict_agent_run,
    is_remote_posix_path_within_root, miniapp_agent_run_tool_restrictions,
    miniapp_headless_agent_tool_restrictions, miniapp_market_strict_agent_tool_restrictions,
    tool_restrictions_for_delegation_policy, ToolPathOperation, ToolPathPolicy,
    ToolRestrictionError, ToolRuntimeRestrictions,
};
use std::path::{Path, PathBuf};

impl From<ToolRestrictionError> for OpenBitFunError {
    fn from(error: ToolRestrictionError) -> Self {
        OpenBitFunError::tool(error.to_string())
    }
}

pub fn is_local_path_within_root(path: &Path, root: &Path) -> OpenBitFunResult<bool> {
    let canonical_path = canonicalize_local_path_best_effort(path)?;
    let canonical_root = canonicalize_local_path_best_effort(root)?;
    Ok(canonical_path == canonical_root || canonical_path.starts_with(&canonical_root))
}

pub(crate) fn canonicalize_local_path_best_effort(path: &Path) -> OpenBitFunResult<PathBuf> {
    if path.exists() {
        return dunce::canonicalize(path).map_err(|err| {
            OpenBitFunError::validation(format!(
                "Failed to canonicalize path '{}': {}",
                path.display(),
                err
            ))
        });
    }

    let mut missing_tail: Vec<PathBuf> = Vec::new();
    let mut current = path;

    loop {
        if current.exists() {
            let mut canonical = dunce::canonicalize(current).map_err(|err| {
                OpenBitFunError::validation(format!(
                    "Failed to canonicalize path '{}': {}",
                    current.display(),
                    err
                ))
            })?;

            for suffix in missing_tail.iter().rev() {
                canonical.push(suffix);
            }

            return Ok(canonical);
        }

        let file_name = current.file_name().ok_or_else(|| {
            OpenBitFunError::validation(format!(
                "Path '{}' cannot be normalized for restriction checks",
                path.display()
            ))
        })?;
        missing_tail.push(PathBuf::from(file_name));

        current = current.parent().ok_or_else(|| {
            OpenBitFunError::validation(format!(
                "Path '{}' cannot be normalized for restriction checks",
                path.display()
            ))
        })?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_restriction_errors_map_to_tool_errors() {
        let error: OpenBitFunError = ToolRestrictionError::Denied {
            tool_name: "AgentSpawn".to_string(),
            message: Some(
                "Recursive subagent delegation is blocked. Use direct tools instead.".to_string(),
            ),
        }
        .into();

        match error {
            OpenBitFunError::Tool(message) => {
                assert_eq!(
                    message,
                    "Recursive subagent delegation is blocked. Use direct tools instead."
                )
            }
            other => panic!("expected tool error, got {:?}", other),
        }
    }

    #[test]
    fn local_path_containment_handles_missing_children() {
        let root =
            std::env::temp_dir().join(format!("openbitfun-restrictions-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("allowed")).expect("create temp root");

        let allowed_child = root.join("allowed").join("nested").join("file.txt");
        let sibling = root.join("blocked").join("file.txt");

        assert!(is_local_path_within_root(&allowed_child, &root.join("allowed")).unwrap());
        assert!(!is_local_path_within_root(&sibling, &root.join("allowed")).unwrap());

        let _ = std::fs::remove_dir_all(&root);
    }
}
