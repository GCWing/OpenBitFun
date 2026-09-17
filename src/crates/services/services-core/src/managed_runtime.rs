//! Managed runtime command resolution.
//!
//! This module owns provider-neutral managed-runtime command discovery. Product
//! crates supply the managed runtime root; command lookup and PATH merging stay
//! reusable and testable without `openbitfun-core`.

use crate::system;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

const DEFAULT_RUNTIME_COMMANDS: &[&str] = &[
    "node", "npm", "npx", "python", "python3", "git", "pandoc", "soffice", "pdftoppm",
];
const MANAGED_COMPONENTS: &[&str] = &["node", "python", "git", "pandoc", "office", "poppler"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimeSource {
    System,
    Managed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedCommand {
    pub command: String,
    pub source: RuntimeSource,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeCommandCapability {
    pub command: String,
    pub available: bool,
    pub source: Option<RuntimeSource>,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ManagedRuntimeResolver {
    runtime_root: PathBuf,
}

struct ManagedCommandSpec {
    component: &'static str,
    candidates: &'static [&'static str],
}

impl ManagedRuntimeResolver {
    pub fn new(runtime_root: impl Into<PathBuf>) -> Self {
        Self {
            runtime_root: runtime_root.into(),
        }
    }

    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }

    pub fn runtime_root_display(&self) -> String {
        self.runtime_root.display().to_string()
    }

    /// Resolve a command from:
    /// 1) explicit path command
    /// 2) system PATH
    /// 3) OpenBitFun managed runtimes
    pub fn resolve_command(&self, command: &str) -> Option<ResolvedCommand> {
        if is_path_like_command(command) {
            return self.resolve_explicit_path_command(command);
        }

        self.resolve_system_command(command)
            .or_else(|| self.resolve_managed_command(command))
    }

    /// Build a snapshot of runtime capabilities for commonly used commands.
    pub fn get_capabilities(&self) -> Vec<RuntimeCommandCapability> {
        DEFAULT_RUNTIME_COMMANDS
            .iter()
            .map(|command| self.get_command_capability(command))
            .collect()
    }

    /// Get capability for an arbitrary command name.
    pub fn get_command_capability(&self, command: &str) -> RuntimeCommandCapability {
        if let Some(resolved) = self.resolve_command(command) {
            RuntimeCommandCapability {
                command: command.to_string(),
                available: true,
                source: Some(resolved.source),
                resolved_path: resolved.resolved_path,
            }
        } else {
            RuntimeCommandCapability {
                command: command.to_string(),
                available: false,
                source: None,
                resolved_path: None,
            }
        }
    }

    /// Build capabilities for multiple commands.
    pub fn get_capabilities_for_commands(
        &self,
        commands: impl IntoIterator<Item = String>,
    ) -> Vec<RuntimeCommandCapability> {
        commands
            .into_iter()
            .map(|command| self.get_command_capability(&command))
            .collect()
    }

    /// Returns managed runtime PATH entries to be prepended to process PATH.
    pub fn managed_path_entries(&self) -> Vec<PathBuf> {
        let mut entries = Vec::new();
        for component in MANAGED_COMPONENTS {
            let component_root = self.runtime_root.join(component).join("current");
            if !component_root.exists() || !component_root.is_dir() {
                continue;
            }

            for rel in managed_component_path_entries(component) {
                let candidate = if rel.is_empty() {
                    component_root.clone()
                } else {
                    component_root.join(rel)
                };

                if candidate.exists() && candidate.is_dir() && !entries.contains(&candidate) {
                    entries.push(candidate);
                }
            }
        }
        entries
    }

    /// Merge managed runtime PATH entries with existing PATH value.
    pub fn merged_path_env(&self, existing_path: Option<&str>) -> Option<String> {
        let managed_entries = self.managed_path_entries();
        let platform_entries = system::platform_path_entries();

        if managed_entries.is_empty()
            && platform_entries.is_empty()
            && existing_path.map(|v| v.trim().is_empty()).unwrap_or(true)
        {
            return None;
        }

        let mut merged = Vec::new();
        let mut seen = HashSet::new();

        for path in managed_entries {
            let key = path.to_string_lossy().to_string();
            if seen.insert(key) {
                merged.push(path);
            }
        }

        if let Some(existing) = existing_path {
            for path in std::env::split_paths(existing) {
                if path.as_os_str().is_empty() {
                    continue;
                }
                let key = path.to_string_lossy().to_string();
                if seen.insert(key) {
                    merged.push(path);
                }
            }
        }

        for path in platform_entries {
            if path.as_os_str().is_empty() {
                continue;
            }
            let key = path.to_string_lossy().to_string();
            if seen.insert(key) {
                merged.push(path);
            }
        }

        std::env::join_paths(merged)
            .ok()
            .map(|v| v.to_string_lossy().to_string())
    }

    fn resolve_system_command(&self, command: &str) -> Option<ResolvedCommand> {
        let check = system::check_command(command);
        if !check.exists {
            return None;
        }

        Some(ResolvedCommand {
            command: check.path.clone().unwrap_or_else(|| command.to_string()),
            source: RuntimeSource::System,
            resolved_path: check.path,
        })
    }

    fn resolve_managed_command(&self, command: &str) -> Option<ResolvedCommand> {
        let managed_path = self.find_managed_command_path(command)?;
        let path_str = managed_path.to_string_lossy().to_string();
        Some(ResolvedCommand {
            command: path_str.clone(),
            source: RuntimeSource::Managed,
            resolved_path: Some(path_str),
        })
    }

    fn resolve_explicit_path_command(&self, command: &str) -> Option<ResolvedCommand> {
        let command_path = Path::new(command);
        if !command_path.exists() || !command_path.is_file() {
            return None;
        }

        Some(ResolvedCommand {
            command: command.to_string(),
            source: RuntimeSource::System,
            resolved_path: Some(command_path.to_string_lossy().to_string()),
        })
    }

    fn find_managed_command_path(&self, command: &str) -> Option<PathBuf> {
        let normalized = normalize_command_alias(command);
        let spec = managed_command_spec(&normalized)?;
        let component_root = self.runtime_root.join(spec.component).join("current");

        for rel in spec.candidates {
            let candidate = component_root.join(rel);
            if candidate.exists() && candidate.is_file() {
                return Some(candidate);
            }
        }

        None
    }
}

/// Prepends app-managed runtime directories to the current process PATH so
/// child processes spawned later (LoopX sidecar, git worktrees, tool hosts)
/// resolve managed commands without a restart.
pub fn prepend_managed_runtime_path(runtime_root: &Path) {
    let resolver = ManagedRuntimeResolver::new(runtime_root);
    if resolver.managed_path_entries().is_empty() {
        return;
    }
    let existing = std::env::var("PATH").ok();
    if let Some(merged) = resolver.merged_path_env(existing.as_deref()) {
        std::env::set_var("PATH", merged);
    }
}

fn normalize_command_alias(command: &str) -> String {
    match command.to_ascii_lowercase().as_str() {
        "node.exe" => "node".to_string(),
        "npm.cmd" | "npm.exe" => "npm".to_string(),
        "npx.cmd" | "npx.exe" => "npx".to_string(),
        "python.exe" => "python".to_string(),
        "python3.exe" => "python3".to_string(),
        "soffice.exe" => "soffice".to_string(),
        "git.exe" => "git".to_string(),
        "pdftoppm.exe" => "pdftoppm".to_string(),
        other => other.to_string(),
    }
}

fn managed_command_spec(command: &str) -> Option<ManagedCommandSpec> {
    match command {
        "node" => Some(ManagedCommandSpec {
            component: "node",
            candidates: &["node", "node.exe", "bin/node", "bin/node.exe"],
        }),
        "npm" => Some(ManagedCommandSpec {
            component: "node",
            candidates: &["npm", "npm.cmd", "bin/npm", "bin/npm.cmd"],
        }),
        "npx" => Some(ManagedCommandSpec {
            component: "node",
            candidates: &["npx", "npx.cmd", "bin/npx", "bin/npx.cmd"],
        }),
        "python" => Some(ManagedCommandSpec {
            component: "python",
            candidates: &[
                "python",
                "python.exe",
                "bin/python",
                "bin/python.exe",
                "bin/python3",
                "bin/python3.exe",
            ],
        }),
        "python3" => Some(ManagedCommandSpec {
            component: "python",
            candidates: &[
                "python3",
                "python3.exe",
                "bin/python3",
                "bin/python3.exe",
                "python",
                "python.exe",
                "bin/python",
                "bin/python.exe",
            ],
        }),
        "git" => Some(ManagedCommandSpec {
            component: "git",
            candidates: &[
                "git",
                "git.exe",
                "bin/git",
                "bin/git.exe",
                "cmd/git.exe",
                "mingw64/bin/git.exe",
            ],
        }),
        "pandoc" => Some(ManagedCommandSpec {
            component: "pandoc",
            candidates: &["pandoc", "pandoc.exe", "bin/pandoc", "bin/pandoc.exe"],
        }),
        "soffice" => Some(ManagedCommandSpec {
            component: "office",
            candidates: &[
                "soffice",
                "soffice.exe",
                "bin/soffice",
                "bin/soffice.exe",
                "program/soffice",
                "program/soffice.exe",
            ],
        }),
        "pdftoppm" => Some(ManagedCommandSpec {
            component: "poppler",
            candidates: &[
                "pdftoppm",
                "pdftoppm.exe",
                "bin/pdftoppm",
                "bin/pdftoppm.exe",
                "Library/bin/pdftoppm.exe",
            ],
        }),
        _ => None,
    }
}

fn managed_component_path_entries(component: &str) -> &'static [&'static str] {
    match component {
        "node" => &["", "bin"],
        "python" => &["", "bin", "Scripts"],
        "git" => &["", "cmd", "bin", "mingw64/bin"],
        "pandoc" => &["", "bin"],
        "office" => &["", "program", "bin"],
        "poppler" => &["", "bin", "Library/bin"],
        _ => &[""],
    }
}

fn is_path_like_command(command: &str) -> bool {
    let p = Path::new(command);
    p.is_absolute() || command.contains('/') || command.contains('\\') || command.starts_with('.')
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn create_test_file(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, b"test").unwrap();
    }

    fn temp_runtime_root() -> PathBuf {
        let mut p = std::env::temp_dir();
        let id = format!(
            "openbitfun-runtime-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        p.push(id);
        p
    }

    #[test]
    fn finds_managed_command_in_component_current_bin() {
        let root = temp_runtime_root();
        let node_path = root.join("node").join("current").join("bin").join("node");
        create_test_file(&node_path);

        let manager = ManagedRuntimeResolver::new(root.clone());
        let resolved = manager.find_managed_command_path("node");
        assert_eq!(resolved.as_deref(), Some(node_path.as_path()));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn normalizes_windows_alias_for_managed_lookup() {
        let root = temp_runtime_root();
        let python_path = root.join("python").join("current").join("python.exe");
        create_test_file(&python_path);

        let manager = ManagedRuntimeResolver::new(root.clone());
        let resolved = manager.find_managed_command_path("python3.exe");
        assert!(resolved.is_some());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn merged_path_env_prepends_managed_entries() {
        let root = temp_runtime_root();
        let node_bin = root.join("node").join("current").join("bin");
        let node_root = root.join("node").join("current");
        fs::create_dir_all(&node_bin).unwrap();
        fs::create_dir_all(&node_root).unwrap();

        let manager = ManagedRuntimeResolver::new(root.clone());
        let existing = if cfg!(windows) {
            r"C:\Windows\System32"
        } else {
            "/usr/bin"
        };
        let merged = manager.merged_path_env(Some(existing)).unwrap();
        let parsed: Vec<_> = std::env::split_paths(&merged).collect();

        assert!(parsed.iter().any(|p| p == &node_bin || p == &node_root));
        assert!(parsed.iter().any(|p| p == &PathBuf::from(existing)));

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn resolves_mingit_layout_from_the_managed_runtime_root() {
        let root = temp_runtime_root();
        let git_path = root.join("git").join("current").join("cmd").join("git.exe");
        create_test_file(&git_path);

        let manager = ManagedRuntimeResolver::new(root.clone());
        let resolved = manager.find_managed_command_path("git");
        assert_eq!(resolved.as_deref(), Some(git_path.as_path()));
        assert!(manager
            .managed_path_entries()
            .iter()
            .any(|p| p == &root.join("git").join("current").join("cmd")));

        let _ = fs::remove_dir_all(root);
    }
}
