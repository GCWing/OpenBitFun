//! Local user-selected locations, independent of Desktop configuration.
use openbitfun_legacy_migration::{LegacyMigrationError, LegacyMigrationResult, MigrationRoots};
use std::path::{Component, Path, PathBuf};

pub(crate) fn validate(roots: &MigrationRoots) -> LegacyMigrationResult<()> {
    let sources = [
        &roots.legacy_user_root,
        &roots.legacy_home_root,
        &roots.legacy_skills_root,
        &roots.legacy_ssh_root,
    ];
    let targets = [
        &roots.target_user_root,
        &roots.target_home_root,
        &roots.target_skills_root,
        &roots.target_ssh_root,
    ];
    let sources = sources
        .into_iter()
        .map(normalized)
        .collect::<LegacyMigrationResult<Vec<_>>>()?;
    let targets = targets
        .into_iter()
        .map(normalized)
        .collect::<LegacyMigrationResult<Vec<_>>>()?;
    for source in &sources {
        for target in &targets {
            if source.starts_with(target) || target.starts_with(source) {
                return Err(LegacyMigrationError::SourceEqualsTarget(source.clone()));
            }
        }
    }
    Ok(())
}

fn normalized(path: &PathBuf) -> LegacyMigrationResult<PathBuf> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(LegacyMigrationError::PathUnavailable(
            "choose an absolute local data directory".into(),
        ));
    }
    // Resolve existing parents too: destinations often do not exist yet.
    let mut parent: &Path = path;
    let mut suffix = Vec::new();
    while !parent.exists() {
        suffix.push(
            parent
                .file_name()
                .ok_or_else(|| LegacyMigrationError::PathUnavailable("data directory".into()))?,
        );
        parent = parent
            .parent()
            .ok_or_else(|| LegacyMigrationError::PathUnavailable("data directory".into()))?;
    }
    if !parent.is_dir() {
        return Err(LegacyMigrationError::PathUnavailable(
            "data directory".into(),
        ));
    }
    let mut resolved =
        std::fs::canonicalize(parent).map_err(|source| LegacyMigrationError::Io {
            path: parent.to_path_buf(),
            source,
        })?;
    for part in suffix.into_iter().rev() {
        resolved.push(part);
    }
    if cfg!(windows) {
        resolved = PathBuf::from(resolved.to_string_lossy().to_lowercase());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn normalizes_missing_children_and_rejects_relative_paths() {
        let temp = tempfile::tempdir().unwrap();
        assert!(normalized(&temp.path().join("missing/child")).is_ok());
        assert!(normalized(&PathBuf::from("relative/data")).is_err());
        assert!(normalized(&temp.path().join("../escape")).is_err());
    }
}
