//! Shell discovery facade and shared candidate metadata.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::ShellType;

mod cache;
mod path;
mod platform;
mod probe;
mod selection;

const VERSION_PROBE_TIMEOUT_MS: u64 = 750;

pub(crate) fn invalidate_cached_executable(path: &Path) {
    cache::invalidate_path(path);
}

/// The source that produced a shell candidate.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShellDiscoverySource {
    ExplicitConfig,
    Path,
    WindowsAppExecutionAlias,
    UserInstall,
    PackageManager,
    SystemInstall,
    Fallback,
}

impl ShellDiscoverySource {
    /// A concise, stable label suitable for diagnostics and API consumers.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ExplicitConfig => "explicitConfig",
            Self::Path => "path",
            Self::WindowsAppExecutionAlias => "windowsAppExecutionAlias",
            Self::UserInstall => "userInstall",
            Self::PackageManager => "packageManager",
            Self::SystemInstall => "systemInstall",
            Self::Fallback => "fallback",
        }
    }
}

#[derive(Debug, Clone)]
pub(super) struct ShellCandidate {
    pub(super) path: PathBuf,
    pub(super) shell_type: ShellType,
    pub(super) source: ShellDiscoverySource,
}

impl ShellCandidate {
    pub(super) fn new(path: PathBuf, shell_type: ShellType, source: ShellDiscoverySource) -> Self {
        Self {
            path,
            shell_type,
            source,
        }
    }
}

/// Shell detector for finding and resolving available shells.
pub struct ShellDetector;

impl ShellDetector {
    /// Detect all available shells. PATH candidates precede fixed install paths
    /// for the same shell type because PATH reflects the user's command policy.
    pub fn detect_available_shells() -> Vec<DetectedShell> {
        let mut candidates = Vec::new();

        #[cfg(windows)]
        {
            candidates.extend(platform::windows_pwsh_candidates());
            candidates.extend(platform::windows_command_candidates());
            candidates.extend(platform::windows_powershell_candidates());
        }
        #[cfg(not(windows))]
        {
            candidates.extend(platform::posix_shell_candidates());
            candidates.extend(platform::non_windows_pwsh_candidates());
        }

        #[cfg(windows)]
        {
            let mut shells = Self::validate_candidates(candidates);
            if let Some(git_bash) = platform::detect_git_bash() {
                if !shells.iter().any(|shell| shell.id == git_bash.id) {
                    shells.push(git_bash);
                }
            }
            shells
        }
        #[cfg(not(windows))]
        {
            Self::validate_candidates(candidates)
        }
    }

    /// Detect Git Bash while excluding Windows' WSL compatibility executable.
    #[cfg(windows)]
    pub fn detect_git_bash() -> Option<DetectedShell> {
        platform::detect_git_bash()
    }

    fn validate_candidates(candidates: Vec<ShellCandidate>) -> Vec<DetectedShell> {
        let mut seen = HashSet::new();
        candidates
            .into_iter()
            .filter(|candidate| seen.insert(path::candidate_identity(candidate)))
            .filter_map(Self::validate_candidate)
            .collect()
    }

    fn validate_first_candidate(candidates: Vec<ShellCandidate>) -> Option<DetectedShell> {
        let mut seen = HashSet::new();
        candidates
            .into_iter()
            .filter(|candidate| seen.insert(path::candidate_identity(candidate)))
            .find_map(Self::validate_candidate)
    }

    fn validate_candidate(candidate: ShellCandidate) -> Option<DetectedShell> {
        let outcome =
            cache::probe_candidate(&candidate.shell_type, &candidate.path, || match &candidate
                .shell_type
            {
                ShellType::PowerShellCore => Self::probe_powershell_version(&candidate.path)
                    .map(|version| cache::CandidateProbeOutcome::Available(Some(version)))
                    .unwrap_or(cache::CandidateProbeOutcome::AvailableWithProbeFailure),
                ShellType::Bash
                | ShellType::Zsh
                | ShellType::Fish
                | ShellType::Sh
                | ShellType::Ksh
                | ShellType::Csh => Self::probe_shell_version(&candidate.path)
                    .map(|version| cache::CandidateProbeOutcome::Available(Some(version)))
                    .unwrap_or(cache::CandidateProbeOutcome::AvailableWithProbeFailure),
                ShellType::PowerShell | ShellType::Cmd | ShellType::Custom(_) => {
                    cache::CandidateProbeOutcome::Available(None)
                }
            });
        let version = match outcome {
            cache::CandidateProbeOutcome::Available(version) => version,
            cache::CandidateProbeOutcome::AvailableWithProbeFailure => None,
            cache::CandidateProbeOutcome::Unavailable => return None,
        };
        Some(DetectedShell::new(
            candidate.shell_type,
            candidate.path,
            version,
            candidate.source,
        ))
    }
}

/// Information about a detected shell.
#[derive(Debug, Clone)]
pub struct DetectedShell {
    /// Stable identity derived from the shell type and canonical executable path.
    pub id: String,
    pub shell_type: ShellType,
    pub path: PathBuf,
    pub version: Option<String>,
    pub display_name: String,
    pub discovery_source: ShellDiscoverySource,
}

impl DetectedShell {
    pub(super) fn new(
        shell_type: ShellType,
        path: PathBuf,
        version: Option<String>,
        discovery_source: ShellDiscoverySource,
    ) -> Self {
        let id = format!("{}:{}", shell_type, path::normalized_path_identity(&path));
        let display_name = shell_display_name(&shell_type, version.as_deref());
        Self {
            id,
            shell_type,
            path,
            version,
            display_name,
            discovery_source,
        }
    }

    pub(super) fn fallback(shell_type: ShellType, path: PathBuf, display_name: &str) -> Self {
        Self {
            id: format!("{}:{}", shell_type, path::normalized_path_identity(&path)),
            shell_type,
            path,
            version: None,
            display_name: display_name.to_string(),
            discovery_source: ShellDiscoverySource::Fallback,
        }
    }

    /// Convert this discovery result into an executable terminal shell config.
    pub fn to_config(&self) -> crate::config::ShellConfig {
        #[cfg(target_os = "macos")]
        let (args, login) = if self.shell_type.is_posix() {
            (vec!["-l".to_string()], true)
        } else {
            (Vec::new(), false)
        };
        #[cfg(target_os = "linux")]
        let (args, login) = (Vec::new(), false);
        #[cfg(windows)]
        let (args, login) = if matches!(self.shell_type, ShellType::Bash) {
            (vec!["--login".to_string(), "-i".to_string()], true)
        } else {
            (Vec::new(), false)
        };
        crate::config::ShellConfig {
            executable: self.path.to_string_lossy().to_string(),
            args,
            env: HashMap::new(),
            cwd: None,
            login,
        }
    }
}

fn shell_display_name(shell_type: &ShellType, version: Option<&str>) -> String {
    match shell_type {
        ShellType::PowerShellCore => version
            .and_then(|version| version.trim().split('.').next())
            .and_then(|major| major.parse::<u32>().ok())
            .map(|major| format!("PowerShell {major}"))
            .unwrap_or_else(|| "PowerShell 7".to_string()),
        _ => shell_type.name().to_string(),
    }
}

#[cfg(test)]
mod tests;
