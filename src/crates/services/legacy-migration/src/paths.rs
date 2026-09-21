use crate::{LegacyMigrationError, LegacyMigrationResult};
use openbitfun_services_core::product_identity::{
    data_namespace, hidden_data_directory, legacy_hidden_data_directory,
};
use std::env;
use std::path::{Path, PathBuf};

pub const LEGACY_PRODUCT_ID: &str = "bitfun";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationRoots {
    pub legacy_user_root: PathBuf,
    pub legacy_home_root: PathBuf,
    pub legacy_skills_root: PathBuf,
    pub legacy_ssh_root: PathBuf,
    pub target_user_root: PathBuf,
    pub target_home_root: PathBuf,
    pub target_skills_root: PathBuf,
    pub target_ssh_root: PathBuf,
}

impl MigrationRoots {
    pub fn resolve_current_user() -> LegacyMigrationResult<Self> {
        let roots = Self::current_user_locations()?;
        roots.validate_distinct()?;
        Ok(roots)
    }

    /// Resolve locations without rejecting editable user overrides at UI startup.
    pub fn current_user_locations() -> LegacyMigrationResult<Self> {
        let config_root = dirs::config_dir().ok_or_else(|| {
            LegacyMigrationError::PathUnavailable("platform config directory".to_string())
        })?;
        let home = dirs::home_dir().ok_or_else(|| {
            LegacyMigrationError::PathUnavailable("current user home directory".to_string())
        })?;
        let data_root = dirs::data_dir().ok_or_else(|| {
            LegacyMigrationError::PathUnavailable("platform data directory".to_string())
        })?;
        let local_data_root = dirs::data_local_dir().ok_or_else(|| {
            LegacyMigrationError::PathUnavailable("platform local data directory".to_string())
        })?;

        let legacy_user_root = env_path("BITFUN_USER_ROOT")
            .or_else(|| env_path("BITFUN_E2E_USER_ROOT"))
            .unwrap_or_else(|| config_root.join(LEGACY_PRODUCT_ID));
        let legacy_home_root = env_path("BITFUN_HOME")
            .or_else(|| env_path("BITFUN_E2E_HOME"))
            .unwrap_or_else(|| home.join(legacy_hidden_data_directory()));
        let target_user_root = env_path("OPENBITFUN_USER_ROOT")
            .or_else(|| env_path("OPENBITFUN_E2E_USER_ROOT"))
            .unwrap_or_else(|| config_root.join(data_namespace()));
        let target_home_root = env_path("OPENBITFUN_HOME")
            .or_else(|| env_path("OPENBITFUN_E2E_HOME"))
            .unwrap_or_else(|| home.join(hidden_data_directory()));

        let legacy_skills_root = platform_skills_root(&data_root, &local_data_root, "BitFun");
        let target_skills_root =
            platform_skills_root(&data_root, &local_data_root, data_namespace());
        let legacy_ssh_root = local_data_root.join("BitFun").join("ssh");
        let target_ssh_root = local_data_root.join("OpenBitFun").join("ssh");

        let roots = Self {
            legacy_user_root,
            legacy_home_root,
            legacy_skills_root,
            legacy_ssh_root,
            target_user_root,
            target_home_root,
            target_skills_root,
            target_ssh_root,
        };
        Ok(roots)
    }

    pub fn migration_root(&self) -> PathBuf {
        self.target_user_root
            .join("data")
            .join("migrations")
            .join("bitfun-to-openbitfun")
    }

    pub fn validate_distinct(&self) -> LegacyMigrationResult<()> {
        for (source, target) in [
            (&self.legacy_user_root, &self.target_user_root),
            (&self.legacy_home_root, &self.target_home_root),
            (&self.legacy_skills_root, &self.target_skills_root),
            (&self.legacy_ssh_root, &self.target_ssh_root),
        ] {
            if paths_equivalent(source, target) {
                return Err(LegacyMigrationError::SourceEqualsTarget(source.clone()));
            }
        }
        Ok(())
    }
}

fn env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .map(PathBuf::from)
        .filter(|path| !path.as_os_str().is_empty())
}

fn platform_skills_root(data_root: &Path, local_data_root: &Path, namespace: &str) -> PathBuf {
    if cfg!(target_os = "windows") {
        data_root.join(namespace).join("skills")
    } else if cfg!(target_os = "macos") {
        dirs::home_dir()
            .unwrap_or_else(|| data_root.to_path_buf())
            .join("Library")
            .join("Application Support")
            .join(namespace)
            .join("skills")
    } else {
        local_data_root.join(namespace).join("skills")
    }
}

fn paths_equivalent(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    if cfg!(windows) {
        left.to_string_lossy()
            .eq_ignore_ascii_case(&right.to_string_lossy())
    } else {
        left == right
    }
}
