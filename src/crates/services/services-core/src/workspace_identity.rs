//! Remote SSH workspace path and identity helpers.

use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{OnceLock, RwLock};

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

    /// Host string for runtime and session paths; see [`ssh_workspace_identity_host`].
    pub fn identity_host(&self) -> String {
        ssh_workspace_identity_host(
            &self.hostname,
            self.remote_connection_id.as_deref(),
            &self.logical_workspace_path,
        )
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

/// Canonical form of an SSH connection id.
///
/// Older builds generated `ssh-user@host:port`; current default-port profiles
/// use `ssh-user@host`. Both spellings name the same saved connection, so
/// persisted workspace records written by either build compare equal after this
/// mapping. Port-scoped ids (`ssh-user@host#port`, see
/// [`ssh_connection_id_for_endpoint`]) are distinct connections and are never
/// collapsed.
pub fn canonical_ssh_connection_id(id: &str) -> String {
    if let Some(rest) = id.strip_prefix("ssh-") {
        if let (Some(at), Some(colon)) = (rest.find('@'), rest.rfind(':')) {
            if colon > at && rest[colon + 1..].parse::<u16>().is_ok() {
                return format!("ssh-{}", &rest[..colon]);
            }
        }
    }
    id.to_string()
}

/// SSH port that keeps the legacy, port-less connection and workspace identity.
pub const DEFAULT_SSH_PORT: u16 = 22;

/// Separator between the host and the port scope of a port-scoped SSH
/// connection id (`ssh-{user}@{host}#{port}`).
///
/// Builds before #710 generated `ssh-{user}@{host}:{port}` for every port and
/// [`canonical_ssh_connection_id`] treats that spelling as an alias of
/// `ssh-{user}@{host}`. Port-scoped ids therefore use a separator no released
/// build ever produced or collapses, so older peers keep treating them as
/// opaque, distinct ids.
pub const SSH_CONNECTION_ID_PORT_SEPARATOR: char = '#';

/// Connection id for a new SSH profile.
///
/// The default port keeps the historical `ssh-{user}@{host}` id byte-for-byte;
/// any other port appends `#{port}` so servers behind one address stay
/// distinct.
pub fn ssh_connection_id_for_endpoint(username: &str, host: &str, port: u16) -> String {
    if port == DEFAULT_SSH_PORT {
        format!("ssh-{username}@{host}")
    } else {
        format!("ssh-{username}@{host}{SSH_CONNECTION_ID_PORT_SEPARATOR}{port}")
    }
}

/// Prefix of the synthetic host profile the Web UI wraps around a saved SSH
/// connection when it discovers Docker containers on it
/// (`workspace-host-{percent-encoded id}`); container profiles derived from it
/// append `-container-{name}`.
const WORKSPACE_HOST_PREFIX: &str = "workspace-host-";

/// Port scope carried by a port-scoped SSH connection id.
///
/// Returns the text after `#` (a port, optionally followed by a `~{n}`
/// disambiguator) for ids shaped `ssh-{user}@{host}#{scope}`, for container
/// ids derived from them (`...#{scope}-container-{name}`), and for synthetic
/// container-host wrappers around them (`workspace-host-{encoded id}...`).
/// Legacy ids, including pre-#710 `ssh-{user}@{host}:{port}` ids and wrappers
/// around them, return `None`.
pub fn ssh_connection_id_port_scope(connection_id: &str) -> Option<String> {
    let id = connection_id.trim();
    if let Some(wrapped) = id.strip_prefix(WORKSPACE_HOST_PREFIX) {
        return direct_port_scope(&percent_decode(wrapped)?).map(str::to_string);
    }
    direct_port_scope(id).map(str::to_string)
}

fn direct_port_scope(id: &str) -> Option<&str> {
    let rest = id.strip_prefix("ssh-")?;
    let at = rest.find('@')?;
    let after_at = &rest[at + 1..];
    let separator = after_at.find(SSH_CONNECTION_ID_PORT_SEPARATOR)?;
    let scope_and_suffix = &after_at[separator + 1..];
    let scope = scope_and_suffix
        .split_once('-')
        .map_or(scope_and_suffix, |(scope, _)| scope);
    let (port, disambiguator) = match scope.split_once('~') {
        Some((port, n)) => (port, Some(n)),
        None => (scope, None),
    };
    if port.is_empty() || !port.bytes().all(|b| b.is_ascii_digit()) || port.parse::<u16>().is_err()
    {
        return None;
    }
    if disambiguator.is_some_and(|n| n.is_empty() || !n.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    Some(scope)
}

/// `decodeURIComponent` for the ids the Web UI encodes; `None` on malformed input.
fn percent_decode(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = value.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// `(connection id, normalized remote root)` pairs pinned to the legacy identity.
fn legacy_identity_records() -> &'static RwLock<HashSet<(String, String)>> {
    static PINNED: OnceLock<RwLock<HashSet<(String, String)>>> = OnceLock::new();
    PINNED.get_or_init(|| RwLock::new(HashSet::new()))
}

fn legacy_identity_key(connection_id: &str, remote_root: &str) -> (String, String) {
    (
        connection_id.trim().to_string(),
        normalize_remote_workspace_path(remote_root),
    )
}

/// Whether a persisted remote workspace record proves that its port-scoped
/// connection was registered with the legacy host-only identity: a host that
/// did not understand port scopes stored it under
/// `remote_workspace_stable_id(host, root)`.
pub fn remote_record_uses_legacy_identity(
    record_id: &str,
    ssh_host: &str,
    connection_id: &str,
    remote_root_norm: &str,
) -> bool {
    ssh_connection_id_port_scope(connection_id).is_some()
        && record_id.trim() == remote_workspace_stable_id(ssh_host, remote_root_norm)
}

/// Keep the host-only identity for one persisted `(connection, root)` record
/// of a port-scoped connection in this process.
///
/// Called when persisted workspace records are loaded, so data an older host
/// wrote under the legacy identity stays where it is after an upgrade. The pin
/// is per root: other workspaces of the same connection keep their port-scoped
/// identity.
pub fn pin_legacy_ssh_workspace_identity(connection_id: &str, remote_root: &str) {
    if connection_id.trim().is_empty() || ssh_connection_id_port_scope(connection_id).is_none() {
        return;
    }
    if let Ok(mut pinned) = legacy_identity_records().write() {
        pinned.insert(legacy_identity_key(connection_id, remote_root));
    }
}

fn legacy_identity_pinned(connection_id: &str, remote_root: &str) -> bool {
    legacy_identity_records()
        .read()
        .map(|pinned| pinned.contains(&legacy_identity_key(connection_id, remote_root)))
        .unwrap_or(false)
}

/// SSH host string used for workspace identity (stable id, runtime key, and
/// session mirror path).
///
/// Connections whose id carries no port scope (every id written by released
/// builds, including all default-port profiles) return `ssh_host` unchanged,
/// so their workspace identity and on-disk layout stay byte-for-byte the same.
/// Port-scoped connections return `{ssh_host}#{scope}`; `#` never appears in a
/// real SSH host, so these identities cannot collide with legacy ones and are
/// a safe path component on every client OS. A root of a port-scoped
/// connection whose record was written with the legacy identity (see
/// [`pin_legacy_ssh_workspace_identity`]) keeps `ssh_host`.
pub fn ssh_workspace_identity_host(
    ssh_host: &str,
    connection_id: Option<&str>,
    remote_root: &str,
) -> String {
    let Some(connection_id) = connection_id else {
        return ssh_host.to_string();
    };
    match ssh_connection_id_port_scope(connection_id) {
        Some(_) if legacy_identity_pinned(connection_id, remote_root) => ssh_host.to_string(),
        Some(scope) => format!(
            "{}{SSH_CONNECTION_ID_PORT_SEPARATOR}{scope}",
            ssh_host.trim()
        ),
        None => ssh_host.to_string(),
    }
}

/// Stable workspace id for a remote workspace owned by `connection_id`.
pub fn remote_workspace_stable_id_for_connection(
    ssh_host: &str,
    connection_id: Option<&str>,
    remote_root_norm: &str,
) -> String {
    remote_workspace_stable_id(
        &ssh_workspace_identity_host(ssh_host, connection_id, remote_root_norm),
        remote_root_norm,
    )
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

/// Build the compact runtime-directory key for a local workspace.
///
/// Runtime keys intentionally omit a product or workspace-kind prefix from
/// the directory name. The domain marker remains part of the hashed input so
/// local and remote identities cannot accidentally share a key.
pub fn local_workspace_runtime_key(canonical_root_norm: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"runtime-local\0");
    hasher.update(canonical_root_norm.as_bytes());
    hex_encode(&hasher.finalize()[..12])
}

/// Build the compact runtime-directory key for a remote workspace.
pub fn remote_workspace_runtime_key(ssh_host: &str, remote_root_norm: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(b"runtime-remote\0");
    hasher.update(ssh_host.trim().to_lowercase().as_bytes());
    hasher.update(b"\0");
    hasher.update(remote_root_norm.as_bytes());
    hex_encode(&hasher.finalize()[..12])
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

#[cfg(test)]
mod tests {
    use super::{
        canonical_ssh_connection_id, pin_legacy_ssh_workspace_identity,
        remote_record_uses_legacy_identity, remote_workspace_runtime_key,
        remote_workspace_session_mirror_dir, remote_workspace_stable_id,
        remote_workspace_stable_id_for_connection, ssh_connection_id_for_endpoint,
        ssh_connection_id_port_scope, ssh_workspace_identity_host,
    };
    use std::path::Path;

    #[test]
    fn default_port_connection_ids_keep_the_legacy_spelling() {
        assert_eq!(
            ssh_connection_id_for_endpoint("root", "example.com", 22),
            "ssh-root@example.com"
        );
        assert_eq!(
            ssh_connection_id_for_endpoint("root", "example.com", 2222),
            "ssh-root@example.com#2222"
        );
    }

    #[test]
    fn port_scope_is_parsed_only_from_port_scoped_ids() {
        assert_eq!(
            ssh_connection_id_port_scope("ssh-root@example.com#2222"),
            Some("2222".to_string())
        );
        assert_eq!(
            ssh_connection_id_port_scope("ssh-root@example.com#2222~2"),
            Some("2222~2".to_string())
        );
        assert_eq!(
            ssh_connection_id_port_scope("ssh-root@example.com#2222-container-web"),
            Some("2222".to_string())
        );
        assert_eq!(
            ssh_connection_id_port_scope("ssh-root@fe80::1#2201"),
            Some("2201".to_string())
        );
        // Every id shape written by released builds stays legacy.
        for legacy in [
            "ssh-root@example.com",
            "ssh-root@example.com:2222",
            "ssh-root@example.com:22",
            "ssh-root@example.com-container-web",
            "wsl-Ubuntu@root",
            "0c9f6c1e-profile",
            "ssh-root@example.com#",
            "ssh-root@example.com#99999",
            "ssh-root@example.com#22x",
            "ssh-root@example.com#22~",
        ] {
            assert_eq!(ssh_connection_id_port_scope(legacy), None, "{legacy}");
        }
    }

    #[test]
    fn legacy_connection_ids_keep_workspace_identity_byte_for_byte() {
        let root = "/home/user/repo";
        let legacy_id = remote_workspace_stable_id("example.com", root);
        for connection_id in [
            None,
            Some("ssh-root@example.com"),
            Some("ssh-root@example.com:2222"),
            Some("ssh-root@example.com-container-web"),
        ] {
            assert_eq!(
                ssh_workspace_identity_host("example.com", connection_id, "/home/user/repo"),
                "example.com"
            );
            assert_eq!(
                remote_workspace_stable_id_for_connection("example.com", connection_id, root),
                legacy_id
            );
        }
    }

    #[test]
    fn port_scoped_connections_get_distinct_workspace_identity() {
        let root = "/home/user/repo";
        let legacy = remote_workspace_stable_id("example.com", root);
        let port_a = remote_workspace_stable_id_for_connection(
            "example.com",
            Some("ssh-u@example.com#2201"),
            root,
        );
        let port_b = remote_workspace_stable_id_for_connection(
            "example.com",
            Some("ssh-u@example.com#2202"),
            root,
        );
        assert_ne!(port_a, legacy);
        assert_ne!(port_b, legacy);
        assert_ne!(port_a, port_b);
        assert_eq!(
            ssh_workspace_identity_host(
                " Example.com ",
                Some("ssh-u@example.com#2201"),
                "/home/user/repo"
            ),
            "Example.com#2201"
        );
        assert_ne!(
            remote_workspace_runtime_key("example.com#2201", root),
            remote_workspace_runtime_key("example.com", root)
        );
        let mirror = remote_workspace_session_mirror_dir(
            Path::new("/mirror"),
            &ssh_workspace_identity_host(
                "example.com",
                Some("ssh-u@example.com#2201"),
                "/home/user/repo",
            ),
            root,
        );
        assert_eq!(
            mirror,
            Path::new("/mirror")
                .join("example.com#2201")
                .join("home")
                .join("user")
                .join("repo")
                .join("sessions")
        );
    }

    #[test]
    fn synthetic_container_host_wrappers_keep_the_wrapped_port_scope() {
        assert_eq!(
            ssh_connection_id_port_scope("workspace-host-ssh-root%40cluster%232201-container-web"),
            Some("2201".to_string())
        );
        assert_eq!(
            ssh_connection_id_port_scope("workspace-host-ssh-root%40cluster%232201"),
            Some("2201".to_string())
        );
        // Wrappers around legacy ids written by released builds stay legacy.
        for legacy in [
            "workspace-host-ssh-root%40cluster-container-web",
            "workspace-host-ssh-root%40cluster%3A2201-container-web",
            "workspace-host-%ZZ",
        ] {
            assert_eq!(ssh_connection_id_port_scope(legacy), None, "{legacy}");
        }
        assert_ne!(
            ssh_workspace_identity_host(
                "cluster",
                Some("workspace-host-ssh-root%40cluster%232201-container-web"),
                "/home/user/repo"
            ),
            ssh_workspace_identity_host(
                "cluster",
                Some("workspace-host-ssh-root%40cluster%232202-container-web"),
                "/home/user/repo"
            )
        );
    }

    #[test]
    fn records_written_with_the_legacy_identity_pin_their_connection() {
        let root = "/srv/pinned";
        let connection = "ssh-root@pinned.example#2201";
        let legacy_id = remote_workspace_stable_id("pinned.example", root);
        assert!(remote_record_uses_legacy_identity(
            &legacy_id,
            "pinned.example",
            connection,
            root
        ));
        assert!(!remote_record_uses_legacy_identity(
            &remote_workspace_stable_id_for_connection("pinned.example", Some(connection), root),
            "pinned.example",
            connection,
            root
        ));
        assert!(!remote_record_uses_legacy_identity(
            &legacy_id,
            "pinned.example",
            "ssh-root@pinned.example",
            root
        ));

        assert_eq!(
            ssh_workspace_identity_host("pinned.example", Some(connection), root),
            "pinned.example#2201"
        );
        pin_legacy_ssh_workspace_identity(connection, root);
        assert_eq!(
            ssh_workspace_identity_host("pinned.example", Some(connection), root),
            "pinned.example"
        );
        assert_eq!(
            remote_workspace_stable_id_for_connection("pinned.example", Some(connection), root),
            legacy_id
        );
        // Other ports of the same host are unaffected.
        assert_eq!(
            ssh_workspace_identity_host(
                "pinned.example",
                Some("ssh-root@pinned.example#2202"),
                root
            ),
            "pinned.example#2202"
        );
    }

    #[test]
    fn loading_one_legacy_root_does_not_reidentify_another_root_on_the_same_connection() {
        let host = "mixed-records.example";
        let connection = "ssh-root@mixed-records.example#2201";
        let legacy_root = "/srv/legacy";
        let scoped_root = "/srv/scoped";
        let legacy_id = remote_workspace_stable_id(host, legacy_root);
        assert!(remote_record_uses_legacy_identity(
            &legacy_id,
            host,
            connection,
            legacy_root
        ));
        let scoped_id =
            remote_workspace_stable_id_for_connection(host, Some(connection), scoped_root);
        pin_legacy_ssh_workspace_identity(connection, legacy_root);
        assert_eq!(
            remote_workspace_stable_id_for_connection(host, Some(connection), legacy_root),
            legacy_id,
            "the pinned record keeps its legacy identity"
        );
        assert_eq!(
            remote_workspace_stable_id_for_connection(host, Some(connection), scoped_root),
            scoped_id,
            "loading a different legacy record must not move an existing workspace's identity"
        );
    }

    #[test]
    fn canonical_ssh_connection_id_never_collapses_port_scoped_ids() {
        assert_eq!(
            canonical_ssh_connection_id("ssh-root@example.com#2222"),
            "ssh-root@example.com#2222"
        );
        assert_eq!(
            canonical_ssh_connection_id("ssh-root@fe80::1#2222"),
            "ssh-root@fe80::1#2222"
        );
    }

    #[test]
    fn canonical_ssh_connection_id_strips_only_legacy_port_suffixes() {
        assert_eq!(
            canonical_ssh_connection_id("ssh-root@example.com:22"),
            "ssh-root@example.com"
        );
        assert_eq!(
            canonical_ssh_connection_id("ssh-root@example.com"),
            "ssh-root@example.com"
        );
        assert_eq!(
            canonical_ssh_connection_id("ssh-root@example.com:not-a-port"),
            "ssh-root@example.com:not-a-port"
        );
        assert_eq!(
            canonical_ssh_connection_id("ssh-user:name@example.com"),
            "ssh-user:name@example.com"
        );
        assert_eq!(
            canonical_ssh_connection_id("0c9f6c1e-profile:22"),
            "0c9f6c1e-profile:22"
        );
    }
}
