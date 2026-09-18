//! MiniApp runtime detection owner.
//!
//! The detector tries Bun first, then Node.js. It checks PATH first, then common
//! install directories, then version-manager directories. This keeps GUI
//! launches with a minimal PATH working without changing the public runtime
//! selection order.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeKind {
    Bun,
    Node,
}

#[derive(Debug, Clone)]
pub struct DetectedRuntime {
    pub kind: RuntimeKind,
    pub path: PathBuf,
    pub version: String,
}

/// Host-backed probe used by the product-domain runtime detector.
///
/// Product-domains owns the search order and fallback orchestration. Core
/// supplies filesystem, PATH, and process-backed version checks through this
/// trait so runtime behavior stays on the legacy adapter path.
pub trait MiniAppRuntimeProbe {
    fn find_on_path(&self, name: &str) -> Option<PathBuf>;
    fn home_dir(&self) -> Option<PathBuf>;
    fn is_executable(&self, path: &Path) -> bool;
    fn version_dirs(&self, root: &Path) -> Vec<PathBuf>;
    fn runtime_version(&self, path: &Path) -> Option<String>;
}

pub fn detect_runtime() -> Option<DetectedRuntime> {
    detect_runtime_with_probe(&DefaultMiniAppRuntimeProbe)
}

struct DefaultMiniAppRuntimeProbe;

impl MiniAppRuntimeProbe for DefaultMiniAppRuntimeProbe {
    fn find_on_path(&self, name: &str) -> Option<PathBuf> {
        which::which(name).ok()
    }

    fn home_dir(&self) -> Option<PathBuf> {
        home_dir()
    }

    fn is_executable(&self, path: &Path) -> bool {
        is_executable(path)
    }

    fn version_dirs(&self, root: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(root)
            .map(|read| read.flatten().map(|entry| entry.path()).collect())
            .unwrap_or_default()
    }

    fn runtime_version(&self, path: &Path) -> Option<String> {
        get_version(path).ok()
    }
}

pub fn detect_runtime_with_probe<P: MiniAppRuntimeProbe + ?Sized>(
    probe: &P,
) -> Option<DetectedRuntime> {
    for name in runtime_lookup_order() {
        let Some(kind) = runtime_kind_for_executable(name) else {
            continue;
        };
        let Some(path) = find_executable_with_probe(probe, name) else {
            continue;
        };
        if let Some(version) = probe.runtime_version(&path) {
            return Some(DetectedRuntime {
                kind,
                path,
                version,
            });
        }
        // Windows: the `which`-style PATH search treats any existing file
        // without an extension as an executable candidate, so an npm-style
        // extensionless shim (a POSIX script that CreateProcess cannot run)
        // can beat the real launcher in the same directory (e.g. `bun` vs
        // `bun.cmd`). Retry the same candidate with the standard executable
        // suffixes before giving up on this runtime.
        #[cfg(windows)]
        {
            for ext in [".exe", ".cmd", ".bat", ".com"] {
                let candidate = append_suffix(&path, ext);
                if let Some(version) = probe.runtime_version(&candidate) {
                    return Some(DetectedRuntime {
                        kind,
                        path: candidate,
                        version,
                    });
                }
            }
        }
    }
    None
}

/// Append an extension suffix to a Windows candidate path, e.g. `bun` -> `bun.cmd`.
#[cfg(windows)]
fn append_suffix(path: &Path, ext: &str) -> PathBuf {
    let mut os = path.as_os_str().to_owned();
    os.push(ext);
    PathBuf::from(os)
}

pub fn runtime_lookup_order() -> &'static [&'static str] {
    &["bun", "node"]
}

pub fn runtime_kind_for_executable(name: &str) -> Option<RuntimeKind> {
    match name {
        "bun" => Some(RuntimeKind::Bun),
        "node" => Some(RuntimeKind::Node),
        _ => None,
    }
}

pub fn candidate_executable_path(dir: impl AsRef<Path>, name: &str) -> PathBuf {
    dir.as_ref().join(name)
}

pub fn versioned_executable_candidate(version_dir: impl AsRef<Path>, name: &str) -> PathBuf {
    version_dir.as_ref().join("bin").join(name)
}

/// Common executable directories checked after PATH lookup.
pub fn candidate_dirs(home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
    ];
    if let Some(home) = home {
        dirs.push(home.join(".bun").join("bin"));
        dirs.push(home.join(".volta").join("bin"));
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join(".asdf").join("shims"));
    }
    dirs
}

/// Version-manager roots that contain `<version>/bin/<runtime>` layouts.
pub fn version_manager_roots(home: Option<&Path>) -> Vec<PathBuf> {
    let Some(home) = home else {
        return Vec::new();
    };
    vec![
        home.join(".nvm").join("versions").join("node"),
        home.join(".fnm").join("node-versions"),
        home.join("Library")
            .join("Application Support")
            .join("fnm")
            .join("node-versions"),
    ]
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

fn is_executable(path: &Path) -> bool {
    path.is_file()
}

fn get_version(executable: &Path) -> Result<String, std::io::Error> {
    let output = create_version_command(executable)
        .arg("--version")
        .output()?;
    if output.status.success() {
        let version = String::from_utf8_lossy(&output.stdout);
        Ok(version.trim().to_string())
    } else {
        Err(std::io::Error::other("version check failed"))
    }
}

fn create_version_command(program: &Path) -> Command {
    let command = Command::new(program);

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        const CREATE_NO_WINDOW: u32 = 0x08000000;
        let mut command = command;
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }

    #[cfg(not(windows))]
    command
}

fn find_executable_with_probe<P: MiniAppRuntimeProbe + ?Sized>(
    probe: &P,
    name: &str,
) -> Option<PathBuf> {
    if let Some(path) = probe.find_on_path(name) {
        return Some(path);
    }
    let home = probe.home_dir();
    for candidate in candidate_dirs(home.as_deref()) {
        let executable = candidate_executable_path(candidate, name);
        if probe.is_executable(&executable) {
            return Some(executable);
        }
    }
    for root in version_manager_roots(home.as_deref()) {
        for version_dir in probe.version_dirs(&root) {
            let executable = versioned_executable_candidate(version_dir, name);
            if probe.is_executable(&executable) {
                return Some(executable);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};

    #[derive(Default)]
    struct FakeProbe {
        path_hits: HashMap<String, PathBuf>,
        executable_hits: HashSet<PathBuf>,
        version_dirs: HashMap<PathBuf, Vec<PathBuf>>,
        versions: HashMap<PathBuf, String>,
        home: Option<PathBuf>,
    }

    impl MiniAppRuntimeProbe for FakeProbe {
        fn find_on_path(&self, name: &str) -> Option<PathBuf> {
            self.path_hits.get(name).cloned()
        }

        fn home_dir(&self) -> Option<PathBuf> {
            self.home.clone()
        }

        fn is_executable(&self, path: &Path) -> bool {
            self.executable_hits.contains(path)
        }

        fn version_dirs(&self, root: &Path) -> Vec<PathBuf> {
            self.version_dirs.get(root).cloned().unwrap_or_default()
        }

        fn runtime_version(&self, path: &Path) -> Option<String> {
            self.versions.get(path).cloned()
        }
    }

    #[test]
    fn detector_keeps_bun_first_path_lookup_before_node() {
        let mut probe = FakeProbe::default();
        let bun = PathBuf::from("/usr/local/bin/bun");
        let node = PathBuf::from("/usr/local/bin/node");
        probe.path_hits.insert("bun".to_string(), bun.clone());
        probe.path_hits.insert("node".to_string(), node.clone());
        probe.versions.insert(bun.clone(), "1.1.0".to_string());
        probe.versions.insert(node, "v20.0.0".to_string());

        let detected = detect_runtime_with_probe(&probe).expect("runtime should be detected");

        assert_eq!(detected.kind, RuntimeKind::Bun);
        assert_eq!(detected.path, bun);
        assert_eq!(detected.version, "1.1.0");
    }

    #[test]
    fn detector_uses_common_home_fallbacks_before_version_manager_dirs() {
        let home = PathBuf::from("/home/demo");
        let fallback = home.join(".volta").join("bin").join("node");
        let nvm_root = home.join(".nvm").join("versions").join("node");
        let nvm_version = nvm_root.join("v20.0.0");
        let nvm_node = nvm_version.join("bin").join("node");

        let mut probe = FakeProbe {
            home: Some(home),
            ..Default::default()
        };
        probe.executable_hits.insert(fallback.clone());
        probe.executable_hits.insert(nvm_node.clone());
        probe.version_dirs.insert(nvm_root, vec![nvm_version]);
        probe
            .versions
            .insert(fallback.clone(), "v18.19.0".to_string());
        probe.versions.insert(nvm_node, "v20.0.0".to_string());

        let detected = detect_runtime_with_probe(&probe).expect("fallback node should be detected");

        assert_eq!(detected.kind, RuntimeKind::Node);
        assert_eq!(detected.path, fallback);
        assert_eq!(detected.version, "v18.19.0");
    }

    #[test]
    fn detector_skips_candidates_when_version_check_fails() {
        let mut probe = FakeProbe::default();
        let bun = PathBuf::from("/usr/local/bin/bun");
        let node = PathBuf::from("/usr/local/bin/node");
        probe.path_hits.insert("bun".to_string(), bun);
        probe.path_hits.insert("node".to_string(), node.clone());
        probe.versions.insert(node.clone(), "v20.0.0".to_string());

        let detected = detect_runtime_with_probe(&probe).expect("node should be detected");

        assert_eq!(detected.kind, RuntimeKind::Node);
        assert_eq!(detected.path, node);
    }

    #[cfg(windows)]
    #[test]
    fn detector_recovers_extensionless_shim_via_pathext_suffixes() {
        // npm installs a POSIX `bun` shim (no extension, not executable by
        // CreateProcess) alongside `bun.cmd`; the PATH search can return the
        // shim first. The detector must retry the executable suffixes and
        // still pick bun over node.
        let mut probe = FakeProbe::default();
        let shim = PathBuf::from(r"C:\Program Files\bun\bun");
        let real = PathBuf::from(r"C:\Program Files\bun\bun.cmd");
        let node = PathBuf::from(r"C:\Program Files\nodejs\node.exe");
        probe.path_hits.insert("bun".to_string(), shim);
        probe.path_hits.insert("node".to_string(), node.clone());
        probe.versions.insert(real.clone(), "1.3.14".to_string());
        probe.versions.insert(node, "v24.0.0".to_string());

        let detected = detect_runtime_with_probe(&probe).expect("bun should be detected");

        assert_eq!(detected.kind, RuntimeKind::Bun);
        assert_eq!(detected.path, real);
        assert_eq!(detected.version, "1.3.14");
    }
}
