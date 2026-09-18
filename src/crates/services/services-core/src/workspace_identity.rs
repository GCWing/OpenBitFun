//! Remote SSH workspace path and identity helpers.

use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

/// SSH host label for local disk workspaces (`Normal` / `Assistant`).
pub const LOCAL_WORKSPACE_SSH_HOST: &str = "localhost";

/// Unified workspace identity used to resolve session persistence for local and remote workspaces.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkspaceSessionIdentity {
    pub workspace_kind: openbitfun_core_types::WorkspaceKind,
    pub hostname: String,
    /// Canonical local root or normalized remote root used to identify the logical workspace.
    pub logical_workspace_path: String,
    pub remote_connection_id: Option<String>,
}

impl WorkspaceSessionIdentity {
    pub fn is_remote(&self) -> bool {
        self.workspace_kind == openbitfun_core_types::WorkspaceKind::Remote
    }

    pub fn logical_workspace_path(&self) -> &str {
        &self.logical_workspace_path
    }
}

/// Normalize a remote POSIX workspace path for registry lookup on any client OS.
pub fn normalize_remote_workspace_path(path: &str) -> String {
    let mut s = path.replace('\\', "/");
    while s.contains("//") {
        s = s.replace("//", "/");
    }
    if s == "/" {
        return s;
    }
    s.trim_end_matches('/').to_string()
}

/// Connection id as one safe local path component.
pub fn sanitize_ssh_connection_id_for_local_dir(connection_id: &str) -> String {
    if connection_id == "." {
        return "_dot_".to_string();
    }
    if connection_id == ".." {
        return "_dotdot_".to_string();
    }
    #[cfg(windows)]
    {
        sanitize_windows_path_component(connection_id)
    }
    #[cfg(not(windows))]
    {
        connection_id
            .chars()
            .map(|character| {
                if character == '/' || character == '\0' {
                    '-'
                } else {
                    character
                }
            })
            .collect()
    }
}

/// Sanitize a single path component for the local remote-workspace mirror tree.
pub fn sanitize_remote_mirror_path_component(component: &str) -> String {
    let t = component.trim();
    if t.is_empty() {
        return "_".to_string();
    }
    if t == "." {
        return "_dot_".to_string();
    }
    if t == ".." {
        return "_dotdot_".to_string();
    }
    #[cfg(windows)]
    {
        sanitize_windows_path_component(t)
    }
    #[cfg(not(windows))]
    {
        t.chars()
            .map(|c| if c == '/' || c == '\0' { '-' } else { c })
            .collect()
    }
}

#[cfg(windows)]
fn sanitize_windows_path_component(component: &str) -> String {
    let mut sanitized: String = component
        .chars()
        .map(|c| match c {
            '<' | '>' | '"' | ':' | '/' | '\\' | '|' | '?' | '*' => '-',
            c if c.is_control() => '-',
            _ => c,
        })
        .collect();
    while sanitized.ends_with('.') || sanitized.ends_with(' ') {
        sanitized.pop();
    }
    if sanitized.is_empty() {
        return "_".to_string();
    }

    let stem = sanitized
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    );
    if reserved {
        sanitized.insert(0, '_');
    }
    sanitized
}

/// SSH host or alias as a single directory name under `remote_ssh/`.
pub fn sanitize_ssh_hostname_for_mirror(host: &str) -> String {
    sanitize_remote_mirror_path_component(&host.trim().to_lowercase())
}

/// Map normalized remote workspace root to path segments under the host directory.
pub fn remote_root_to_mirror_subpath(remote_root_norm: &str) -> PathBuf {
    let mut pb = PathBuf::new();
    if remote_root_norm == "/" {
        pb.push("_root");
        return pb;
    }
    for seg in remote_root_norm.trim_start_matches('/').split('/') {
        if seg.is_empty() {
            continue;
        }
        if seg == "." {
            continue;
        }
        if seg == ".." {
            // Match the effective local path produced by the legacy
            // `PathBuf::push("..")` mapping without allowing the result to
            // escape the host mirror root.
            pb.pop();
            continue;
        }
        pb.push(sanitize_remote_mirror_path_component(seg));
    }
    if pb.as_os_str().is_empty() {
        pb.push("_root");
    }
    pb
}

/// Local runtime root for a registered remote workspace.
pub fn remote_workspace_runtime_root(
    remote_mirror_root: impl AsRef<Path>,
    ssh_host: &str,
    remote_root_norm: &str,
) -> PathBuf {
    remote_mirror_root
        .as_ref()
        .join(sanitize_ssh_hostname_for_mirror(ssh_host))
        .join(remote_root_to_mirror_subpath(remote_root_norm))
}

/// Local persisted-session mirror directory for a registered remote workspace.
pub fn remote_workspace_session_mirror_dir(
    remote_mirror_root: impl AsRef<Path>,
    ssh_host: &str,
    remote_root_norm: &str,
) -> PathBuf {
    remote_workspace_runtime_root(remote_mirror_root, ssh_host, remote_root_norm).join("sessions")
}

/// Canonical local root [`PathBuf`] plus stable slash-normalized string form.
pub fn canonicalize_local_workspace_root(path: &Path) -> Result<(PathBuf, String), String> {
    let canonical = dunce::canonicalize(path).map_err(|err| {
        format!(
            "Failed to canonicalize local workspace path '{}': {}",
            path.display(),
            err
        )
    })?;
    let stable = path_buf_to_stable_local_root_string(&canonical);
    Ok((canonical, stable))
}

/// Canonical absolute local path as a stable UTF-8 string.
pub fn normalize_local_workspace_root_for_stable_id(path: &Path) -> Result<String, String> {
    Ok(canonicalize_local_workspace_root(path)?.1)
}

fn path_buf_to_stable_local_root_string(canonical: &Path) -> String {
    canonical.to_string_lossy().replace('\\', "/")
}

/// Whether two local paths refer to the same workspace root.
pub fn local_workspace_roots_equal(a: &Path, b: &Path) -> bool {
    match (
        normalize_local_workspace_root_for_stable_id(a),
        normalize_local_workspace_root_for_stable_id(b),
    ) {
        (Ok(left), Ok(right)) => left == right,
        _ => a == b,
    }
}

/// Build a unified session identity for local or remote workspaces.
pub fn workspace_session_identity(
    workspace_path: &str,
    remote_connection_id: Option<&str>,
    remote_ssh_host: Option<&str>,
) -> Option<WorkspaceSessionIdentity> {
    let remote_connection_id = remote_connection_id
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    if let Some(connection_id) = remote_connection_id {
        let hostname = remote_ssh_host
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)?;
        return Some(WorkspaceSessionIdentity {
            workspace_kind: openbitfun_core_types::WorkspaceKind::Remote,
            hostname,
            logical_workspace_path: normalize_remote_workspace_path(workspace_path),
            remote_connection_id: Some(connection_id),
        });
    }

    let local_root =
        normalize_local_workspace_root_for_stable_id(Path::new(workspace_path)).ok()?;
    Some(WorkspaceSessionIdentity {
        workspace_kind: openbitfun_core_types::WorkspaceKind::Normal,
        hostname: LOCAL_WORKSPACE_SSH_HOST.to_string(),
        logical_workspace_path: local_root,
        remote_connection_id: None,
    })
}

/// Human-readable logical key: `{host}:{normalized_absolute_root}`.
pub fn workspace_logical_key(ssh_host: &str, root_norm: &str) -> String {
    format!("{}:{}", ssh_host.trim(), root_norm)
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

fn hash_host_and_root(host: &str, root_norm: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(host.trim().to_lowercase().as_bytes());
    hasher.update(b"\n");
    hasher.update(root_norm.as_bytes());
    hex_encode(&hasher.finalize()[..16])
}

/// Stable storage id for a local workspace (`localhost` + canonical absolute root).
pub fn local_workspace_stable_storage_id(canonical_root_norm: &str) -> String {
    format!(
        "local_{}",
        hash_host_and_root(LOCAL_WORKSPACE_SSH_HOST, canonical_root_norm)
    )
}

/// Stable workspace id from SSH host + normalized remote root.
pub fn remote_workspace_stable_id(ssh_host: &str, remote_root_norm: &str) -> String {
    format!("remote_{}", hash_host_and_root(ssh_host, remote_root_norm))
}

/// Stable unresolved-session key used while a remote host cannot be resolved.
pub fn unresolved_remote_session_storage_key(
    connection_id: &str,
    workspace_path_norm: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"unresolved_remote_session\x01");
    hasher.update(connection_id.trim().as_bytes());
    hasher.update(b"\0");
    hasher.update(workspace_path_norm.as_bytes());
    hex_encode(&hasher.finalize()[..12])
}

/// Dedicated session tree used while a remote host cannot yet be resolved.
pub fn unresolved_remote_session_storage_dir(
    remote_mirror_root: impl AsRef<Path>,
    connection_id: &str,
    workspace_path_norm: &str,
) -> PathBuf {
    let key = unresolved_remote_session_storage_key(connection_id, workspace_path_norm);
    remote_mirror_root
        .as_ref()
        .join("_unresolved")
        .join(key)
        .join("sessions")
}

pub fn build_project_runtime_slug(canonical: &str) -> String {
    let slug: String = canonical
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();

    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "workspace" } else { slug };

    if slug.len() <= 120 {
        return slug.to_string();
    }

    let hash = format!("{:x}", Sha256::digest(canonical.as_bytes()));
    let suffix = &hash[..12];
    let max_prefix_len = 120_usize.saturating_sub(suffix.len() + 1);
    let prefix = slug[..max_prefix_len].trim_end_matches('-');
    format!("{}-{}", prefix, suffix)
}
