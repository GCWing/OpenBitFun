//! Explicit, confirmed reset of destination data. Source data is never removed.
use crate::{LegacyMigrationError, LegacyMigrationResult, MigrationRoots};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResetDirectory {
    pub path: PathBuf,
    pub exists: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetResetResult {
    pub removed: Vec<PathBuf>,
    pub missing: Vec<PathBuf>,
    pub failed: Vec<PathBuf>,
}

/// Resolve existing parents and refuse links/junctions at any root component.
fn normalized(path: &Path) -> LegacyMigrationResult<PathBuf> {
    if !path.is_absolute()
        || path.parent().is_none()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
    {
        return Err(LegacyMigrationError::PathEscape(path.into()));
    }
    let mut prefix = PathBuf::new();
    for component in path.components() {
        prefix.push(component);
        // A Windows drive/UNC prefix alone is not a complete absolute path.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        match fs::symlink_metadata(&prefix) {
            Ok(metadata) => {
                #[cfg(windows)]
                let reparse = {
                    use std::os::windows::fs::MetadataExt;
                    metadata.file_attributes() & 0x0400 != 0
                };
                #[cfg(not(windows))]
                let reparse = false;
                if metadata.file_type().is_symlink() || reparse {
                    return Err(LegacyMigrationError::LinkedPath(prefix));
                }
                if !metadata.is_dir() {
                    return Err(LegacyMigrationError::PathEscape(prefix));
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(LegacyMigrationError::Io {
                    path: prefix,
                    source: error,
                })
            }
        }
    }
    let mut existing = path;
    let mut suffix = Vec::new();
    while !existing.exists() {
        suffix.push(
            existing
                .file_name()
                .ok_or_else(|| LegacyMigrationError::PathEscape(path.into()))?,
        );
        existing = existing
            .parent()
            .ok_or_else(|| LegacyMigrationError::PathEscape(path.into()))?;
    }
    let mut resolved = fs::canonicalize(existing).map_err(|source| LegacyMigrationError::Io {
        path: existing.into(),
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

pub fn plan_target_reset(
    roots: &MigrationRoots,
    protected_directories: &[PathBuf],
) -> LegacyMigrationResult<Vec<ResetDirectory>> {
    let defaults = MigrationRoots::current_user_locations()?;
    let mut protected = vec![
        roots.legacy_user_root.clone(),
        roots.legacy_home_root.clone(),
        roots.legacy_skills_root.clone(),
        roots.legacy_ssh_root.clone(),
        defaults.legacy_user_root,
        defaults.legacy_home_root,
        defaults.legacy_skills_root,
        defaults.legacy_ssh_root,
    ];
    let mut preserved = protected
        .iter()
        .map(|path| normalized(path))
        .collect::<LegacyMigrationResult<Vec<_>>>()?;
    preserved.extend(
        protected_directories
            .iter()
            .map(|path| normalized(path))
            .collect::<LegacyMigrationResult<Vec<_>>>()?,
    );
    for base in [
        dirs::home_dir(),
        dirs::config_dir(),
        dirs::data_dir(),
        dirs::data_local_dir(),
        dirs::cache_dir(),
    ] {
        protected.push(
            base.ok_or_else(|| LegacyMigrationError::PathUnavailable("platform directory".into()))?,
        );
    }
    protected.extend_from_slice(protected_directories);
    let protected = protected
        .iter()
        .map(|path| normalized(path))
        .collect::<LegacyMigrationResult<Vec<_>>>()?;
    let mut candidates = roots
        .target_reset_roots()?
        .into_iter()
        .map(|path| normalized(&path).map(|resolved| (path, resolved)))
        .collect::<LegacyMigrationResult<Vec<_>>>()?;
    candidates.sort_by_key(|(_, resolved)| resolved.components().count());
    let mut selected: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (path, resolved) in candidates {
        if protected.iter().any(|keep| keep.starts_with(&resolved))
            || preserved.iter().any(|keep| resolved.starts_with(keep))
        {
            return Err(LegacyMigrationError::PathEscape(path));
        }
        if !selected
            .iter()
            .any(|(_, parent)| resolved.starts_with(parent))
        {
            selected.push((path, resolved));
        }
    }
    selected
        .into_iter()
        .map(|(path, _)| {
            let exists = match fs::symlink_metadata(&path) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(source) => return Err(LegacyMigrationError::Io { path, source }),
            };
            Ok(ResetDirectory { path, exists })
        })
        .collect()
}

/// The host must exclude concurrent migration and check data writers first.
/// Revalidate the whole scope before deleting anything. Partial failures remain
/// visible and can be retried; deletion is never presented as atomic or reversible.
pub fn reset_target_data(
    roots: &MigrationRoots,
    confirmed: &[ResetDirectory],
    protected_directories: &[PathBuf],
) -> LegacyMigrationResult<TargetResetResult> {
    let current = plan_target_reset(roots, protected_directories)?;
    if current != confirmed {
        return Err(LegacyMigrationError::InvalidRequest(
            "reset destinations changed; review them again".into(),
        ));
    }
    let mut result = TargetResetResult::default();
    for directory in current {
        // Repeat root checks immediately before removal. Rust's remove_dir_all
        // removes child symlinks themselves rather than following their targets.
        if normalized(&directory.path).is_err() {
            result.failed.push(directory.path);
            continue;
        }
        match fs::remove_dir_all(&directory.path) {
            Ok(()) => result.removed.push(directory.path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                result.missing.push(directory.path)
            }
            Err(_) => result.failed.push(directory.path),
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn create_directory_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            // Junctions exercise reparse safety without requiring symlink privilege.
            let output = openbitfun_services_core::process_manager::create_command("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "junction creation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    fn roots(root: &Path) -> MigrationRoots {
        // macOS temporary directories may have a system symlink in their prefix.
        let root = fs::canonicalize(root).unwrap();
        MigrationRoots {
            legacy_user_root: root.join("legacy/user"),
            legacy_home_root: root.join("legacy/home"),
            legacy_skills_root: root.join("legacy/skills"),
            legacy_ssh_root: root.join("legacy/ssh"),
            target_user_root: root.join("target/user"),
            target_home_root: root.join("target/home"),
            target_skills_root: root.join("target/user/skills"),
            target_ssh_root: root.join("target/ssh"),
        }
    }

    #[test]
    fn reset_removes_only_confirmed_destinations_and_merges_nested_roots() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(temp.path());
        fs::create_dir_all(&roots.legacy_user_root).unwrap();
        fs::write(roots.legacy_user_root.join("keep"), "source").unwrap();
        fs::create_dir_all(roots.target_user_root.join("data/migrations/runs")).unwrap();
        fs::write(
            roots.target_user_root.join("data/migrations/runs/report"),
            "old report",
        )
        .unwrap();
        fs::create_dir_all(&roots.target_home_root).unwrap();
        let plan = plan_target_reset(&roots, &[]).unwrap();
        assert_eq!(plan.len(), 3);
        let result = reset_target_data(&roots, &plan, &[]).unwrap();
        assert_eq!(result.removed.len(), 2);
        assert_eq!(result.missing.len(), 1);
        assert!(result.failed.is_empty());
        assert_eq!(
            fs::read_to_string(roots.legacy_user_root.join("keep")).unwrap(),
            "source"
        );
        assert!(!roots.target_user_root.exists());
        assert!(!roots.target_home_root.exists());
        let plan = plan_target_reset(&roots, &[]).unwrap();
        assert_eq!(
            reset_target_data(&roots, &plan, &[]).unwrap().missing.len(),
            3
        );
    }

    #[test]
    fn standard_reset_scope_covers_platform_product_roots() {
        let roots = MigrationRoots::current_user_locations().unwrap();
        let candidates = roots.target_reset_roots().unwrap();
        for required in [
            roots.target_user_root,
            roots.target_home_root,
            roots.target_skills_root.parent().unwrap().to_path_buf(),
            roots.target_ssh_root.parent().unwrap().to_path_buf(),
            dirs::data_local_dir()
                .unwrap()
                .join("com.openbitfun.desktop"),
            dirs::cache_dir().unwrap().join("com.openbitfun.desktop"),
        ] {
            assert!(
                candidates.contains(&required),
                "missing reset root: {}",
                required.display()
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn locked_directory_is_reported_and_other_destinations_are_still_removed() {
        use std::os::windows::fs::OpenOptionsExt;
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(temp.path());
        fs::create_dir_all(&roots.target_home_root).unwrap();
        fs::create_dir_all(&roots.target_user_root).unwrap();
        let file = fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .share_mode(0)
            .open(roots.target_home_root.join("locked"))
            .unwrap();
        let plan = plan_target_reset(&roots, &[]).unwrap();
        let result = reset_target_data(&roots, &plan, &[]).unwrap();
        assert_eq!(result.failed, vec![roots.target_home_root.clone()]);
        assert_eq!(result.removed, vec![roots.target_user_root.clone()]);
        assert!(roots.target_home_root.join("locked").exists());
        drop(file);
        let plan = plan_target_reset(&roots, &[]).unwrap();
        assert!(reset_target_data(&roots, &plan, &[])
            .unwrap()
            .failed
            .is_empty());
    }

    #[test]
    fn unsafe_or_changed_scopes_fail_before_any_deletion() {
        let temp = tempfile::tempdir().unwrap();
        let mut roots = roots(temp.path());
        fs::create_dir_all(&roots.target_user_root).unwrap();
        fs::write(roots.target_user_root.join("keep"), "target").unwrap();
        let plan = plan_target_reset(&roots, &[]).unwrap();
        fs::create_dir_all(&roots.target_home_root).unwrap();
        assert!(reset_target_data(&roots, &plan, &[]).is_err());
        assert!(plan_target_reset(&roots, &[roots.target_user_root.clone()]).is_err());
        assert!(plan_target_reset(
            &roots,
            &[roots.target_user_root.parent().unwrap().to_path_buf()]
        )
        .is_err());
        for unsafe_root in [
            temp.path().to_path_buf(),
            roots.legacy_home_root.clone(),
            roots.legacy_home_root.join("child"),
            PathBuf::from("relative"),
            dirs::home_dir().unwrap(),
        ] {
            roots.target_home_root = unsafe_root;
            assert!(plan_target_reset(&roots, &[]).is_err());
            assert_eq!(
                fs::read_to_string(roots.target_user_root.join("keep")).unwrap(),
                "target"
            );
        }
    }

    #[test]
    fn root_links_are_rejected_and_child_links_do_not_delete_sources() {
        let temp = tempfile::tempdir().unwrap();
        let roots = roots(temp.path());
        fs::create_dir_all(&roots.legacy_home_root).unwrap();
        fs::write(roots.legacy_home_root.join("keep"), "source").unwrap();
        fs::create_dir_all(roots.target_home_root.parent().unwrap()).unwrap();
        create_directory_link(&roots.legacy_home_root, &roots.target_home_root);
        assert!(plan_target_reset(&roots, &[]).is_err());
        fs::remove_dir(&roots.target_home_root)
            .or_else(|_| fs::remove_file(&roots.target_home_root))
            .unwrap();
        fs::create_dir_all(&roots.target_home_root).unwrap();
        create_directory_link(
            &roots.legacy_home_root,
            &roots.target_home_root.join("linked-source"),
        );
        let plan = plan_target_reset(&roots, &[]).unwrap();
        assert!(reset_target_data(&roots, &plan, &[])
            .unwrap()
            .failed
            .is_empty());
        assert_eq!(
            fs::read_to_string(roots.legacy_home_root.join("keep")).unwrap(),
            "source"
        );
    }
}
