//! Product Operation Registry: the surface-neutral contract for every product
//! operation that can cross a host boundary.
//!
//! OpenBitFun has one Agent Runtime but several ways to reach it: the local Desktop
//! window, a remote SSH/Docker workspace, a Peer Device controller driving a
//! Desktop or CLI host, and detached dispatch. Each of those surfaces used to
//! keep its own hand-written table of what a command may do there (the desktop
//! remote-workspace policy table, three Peer Device deny lists, the CLI peer
//! host dispatch match, two hand-written capability objects). Nothing but
//! review kept them in agreement, and every gap became a remote-only defect.
//!
//! This module is the single owner of those facts. Hosts and generated
//! frontend artifacts derive their tables from it; contract tests prove the
//! derivations are complete. See `docs/architecture/remote-surface-contract.md`.
//!
//! The registry is behavior-light: it names operations and declares stances.
//! It does not execute anything and must not depend on any runtime crate.

mod baseline;
mod capabilities;
mod table;

use std::collections::BTreeSet;

use serde::{Deserialize, Serialize};

pub use capabilities::{advertised_by, advertises, capability_map, PeerHostCapability};

/// Wire schema version of the exported registry artifact.
pub const REMOTE_SURFACE_SCHEMA_VERSION: u32 = 1;

/// How a command behaves when the active workspace is a remote SSH/Docker
/// workspace. The serde names are the historical desktop policy names so the
/// generated `tauri-command-map.json` keeps its values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RemoteWorkspaceStance {
    /// The handler detects remote workspace paths/sessions and executes on the
    /// remote host, or is itself part of the remote workspace machinery.
    #[serde(rename = "RemoteRouted")]
    Routed,
    /// The handler explicitly rejects remote workspaces with a clear,
    /// user-visible error or gated UI state.
    #[serde(rename = "RemoteUnsupported")]
    Unsupported,
    /// The command intentionally operates on the local host regardless of
    /// workspace (windowing, tray, local browser, devtools, OS automation).
    #[serde(rename = "LocalOnly")]
    LocalOnly,
    /// Behavior does not depend on where the workspace filesystem lives.
    #[serde(rename = "WorkspaceAgnostic")]
    Agnostic,
    /// Frozen backlog; must not grow. See `baseline.rs`.
    #[serde(rename = "LegacyUnaudited")]
    Unaudited,
}

/// Whether the operation id is a registered Desktop Tauri command or a name
/// that only exists on the HostInvoke wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OperationSurface {
    /// Registered in the desktop `generate_handler!` block.
    TauriCommand,
    /// A CLI peer host alias kept for older controllers, or a detached
    /// dispatch target verb routed before the peer bridge.
    HostInvokeOnly,
}

/// How Peer Device Mode treats the operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum PeerStance {
    /// The controller forwards it; the selected peer host executes it.
    Proxied,
    /// The controller keeps it local (window chrome, updater, account
    /// identity, local OS automation); every peer host refuses it.
    ControllerLocal,
    /// Peer hosts refuse it, and the controller must not run it locally
    /// either: the operation only makes sense on the machine that owns the
    /// workspace, so the controller forwards it to obtain the explicit refusal
    /// (for example `git_trust_repository`, which surfaces a manual command).
    OperatorOnly,
    /// Answered by the host before the deny check: peer control attach/detach,
    /// `peer_mode_ping`, and the detached dispatch target verbs.
    HostControlPlane,
    /// A protocol tombstone kept after its runtime owner was removed.
    Retired { reason: &'static str },
}

/// The kinds of peer host that answer HostInvoke.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PeerHostKind {
    Desktop,
    Cli,
}

impl PeerHostKind {
    /// The `host_type` value published by `peer_mode_ping`.
    pub const fn as_wire_str(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Cli => "cli",
        }
    }

    /// Human-readable host name used in refusal messages.
    pub const fn display_name(self) -> &'static str {
        match self {
            Self::Desktop => "desktop",
            Self::Cli => "CLI",
        }
    }
}

/// Whether one kind of peer host can execute an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum HostSupport {
    /// The host runs the real owner handler.
    Handled,
    /// The host refuses with a typed error carrying this reason.
    Unsupported { reason: &'static str },
    /// The host answers with an empty or no-op success because the desktop
    /// subsystem behind the command does not exist there. Each such answer is
    /// declared here so it is a reviewed contract, not an accidental gap.
    SoftEmpty { reason: &'static str },
}

impl HostSupport {
    pub const fn is_handled(self) -> bool {
        matches!(self, Self::Handled)
    }

    pub const fn is_soft_empty(self) -> bool {
        matches!(self, Self::SoftEmpty { .. })
    }

    pub const fn is_unsupported(self) -> bool {
        matches!(self, Self::Unsupported { .. })
    }
}

/// One product operation and its stance on every remote scenario.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationDefinition {
    pub id: &'static str,
    pub surface: OperationSurface,
    pub remote_workspace: RemoteWorkspaceStance,
    pub peer: PeerStance,
    pub cli_peer: HostSupport,
}

impl OperationDefinition {
    /// Support on a peer host of the given kind.
    ///
    /// Desktop support is derived rather than tabulated: every registered Tauri
    /// command is handled by the desktop webview bridge, while HostInvoke-only
    /// names are handled there only when they belong to the host control plane.
    pub fn host_support(&self, host: PeerHostKind) -> HostSupport {
        match host {
            PeerHostKind::Cli => self.cli_peer,
            PeerHostKind::Desktop => match (self.surface, self.peer) {
                (OperationSurface::TauriCommand, _) => HostSupport::Handled,
                (OperationSurface::HostInvokeOnly, PeerStance::HostControlPlane) => {
                    HostSupport::Handled
                }
                (OperationSurface::HostInvokeOnly, _) => HostSupport::Unsupported {
                    reason: "this name is a CLI peer host alias; the desktop host registers the canonical command",
                },
            },
        }
    }

    /// Whether the controller keeps this operation local instead of
    /// forwarding it to the rendered peer.
    pub const fn is_controller_local(&self) -> bool {
        matches!(
            self.peer,
            PeerStance::ControllerLocal | PeerStance::HostControlPlane
        )
    }

    /// Whether every peer host must refuse this operation before dispatch.
    pub const fn is_refused_by_peer_hosts(&self) -> bool {
        matches!(
            self.peer,
            PeerStance::ControllerLocal | PeerStance::OperatorOnly
        )
    }
}

/// Command-name prefixes retired together with their runtime owner. They are
/// refused with a stable message so an older controller learns the owner is
/// gone instead of receiving an unknown-command error.
pub const RETIRED_COMMAND_PREFIXES: &[(&str, &str)] =
    &[("lsp_", "the OpenBitFun LSP runtime has been retired")];

/// Every operation, sorted by id.
pub fn operations() -> &'static [OperationDefinition] {
    table::OPERATIONS
}

/// Look up one operation by id.
pub fn operation(id: &str) -> Option<&'static OperationDefinition> {
    let table = table::OPERATIONS;
    table
        .binary_search_by(|definition| definition.id.cmp(id))
        .ok()
        .map(|index| &table[index])
}

/// The reason a command is retired, if its name matches a retired prefix or
/// an explicit `Retired` row.
pub fn retired_reason(command: &str) -> Option<&'static str> {
    if let Some(PeerStance::Retired { reason }) = operation(command).map(|op| op.peer) {
        return Some(reason);
    }
    RETIRED_COMMAND_PREFIXES
        .iter()
        .find(|(prefix, _)| command.starts_with(prefix))
        .map(|(_, reason)| *reason)
}

/// The Peer Device stance for a command name, including prefix-retired names.
pub fn peer_stance(command: &str) -> Option<PeerStance> {
    if let Some(definition) = operation(command) {
        return Some(definition.peer);
    }
    retired_reason(command).map(|reason| PeerStance::Retired { reason })
}

/// Registered Tauri commands the controller keeps local instead of forwarding
/// to the rendered peer. This is the single definition of the frontend
/// `LOCAL_ONLY` set.
pub fn controller_local_commands() -> impl Iterator<Item = &'static str> {
    operations()
        .iter()
        .filter(|op| op.surface == OperationSurface::TauriCommand && op.is_controller_local())
        .map(|op| op.id)
}

/// Why a peer host refuses a HostInvoke command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRefusal {
    EmptyCommand,
    Retired {
        reason: &'static str,
    },
    /// `ControllerLocal` and `OperatorOnly` share this refusal: the peer host
    /// never runs the command on a controller's behalf.
    ControllerLocal,
    HostUnsupported {
        host: PeerHostKind,
        reason: &'static str,
    },
    /// The name is not in this build's registry: either a command a newer
    /// controller added, or a typo. Distinct from `HostUnsupported` so a
    /// controller can tell "upgrade the peer" from "this host kind cannot".
    UnknownToHost {
        host: PeerHostKind,
    },
}

impl PeerRefusal {
    /// The user-visible error string. This is the only place these strings are
    /// produced; the frontend matches on the local-only and CLI-unsupported
    /// prefixes, so they stay byte-stable and new information is appended.
    pub fn message(&self, command: &str) -> String {
        match self {
            Self::EmptyCommand => "HostInvoke command is empty".to_string(),
            Self::Retired { reason } => {
                format!("command '{command}' is unsupported because {reason}")
            }
            Self::ControllerLocal => {
                format!("command '{command}' is local-only and cannot run on peer")
            }
            Self::HostUnsupported { host, reason } => format!(
                "command '{command}' is not supported on {} peer host: {reason}",
                host.display_name()
            ),
            Self::UnknownToHost { host } => format!(
                "command '{command}' is unknown to this OpenBitFun {} peer host version; upgrade the peer host or check the command name",
                host.display_name()
            ),
        }
    }
}

/// The routing decision a peer host makes for one HostInvoke command.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerHostVerdict {
    /// Answer through the host control plane (attach/detach/ping/dispatch
    /// target verbs) before any product dispatch.
    HostControlPlane,
    /// Run the product handler (or the declared soft-empty answer).
    Execute,
    Refuse(PeerRefusal),
}

/// Decide how a peer host of the given kind handles a HostInvoke command.
///
/// The order matches the historical host behavior: empty, retired, control
/// plane, controller-owned, host-unsupported, execute, unknown.
pub fn peer_host_verdict(command: &str, host: PeerHostKind) -> PeerHostVerdict {
    if command.is_empty() {
        return PeerHostVerdict::Refuse(PeerRefusal::EmptyCommand);
    }
    if let Some(reason) = retired_reason(command) {
        return PeerHostVerdict::Refuse(PeerRefusal::Retired { reason });
    }
    let Some(definition) = operation(command) else {
        return PeerHostVerdict::Refuse(PeerRefusal::UnknownToHost { host });
    };
    match definition.peer {
        PeerStance::HostControlPlane => PeerHostVerdict::HostControlPlane,
        PeerStance::ControllerLocal | PeerStance::OperatorOnly => {
            PeerHostVerdict::Refuse(PeerRefusal::ControllerLocal)
        }
        PeerStance::Retired { reason } => PeerHostVerdict::Refuse(PeerRefusal::Retired { reason }),
        PeerStance::Proxied => match definition.host_support(host) {
            HostSupport::Handled | HostSupport::SoftEmpty { .. } => PeerHostVerdict::Execute,
            HostSupport::Unsupported { reason } => {
                PeerHostVerdict::Refuse(PeerRefusal::HostUnsupported { host, reason })
            }
        },
    }
}

/// The exported registry artifact consumed by the capability generator.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteSurfaceRegistryExport {
    pub schema_version: u32,
    pub digest: String,
    pub retired_command_prefixes: Vec<RetiredPrefixExport>,
    pub capabilities: CapabilitiesExport,
    pub operations: Vec<OperationDefinition>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredPrefixExport {
    pub prefix: &'static str,
    pub reason: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesExport {
    pub ids: Vec<&'static str>,
    pub desktop: Vec<&'static str>,
    pub cli: Vec<&'static str>,
}

fn export_without_digest() -> RemoteSurfaceRegistryExport {
    RemoteSurfaceRegistryExport {
        schema_version: REMOTE_SURFACE_SCHEMA_VERSION,
        digest: String::new(),
        retired_command_prefixes: RETIRED_COMMAND_PREFIXES
            .iter()
            .map(|(prefix, reason)| RetiredPrefixExport { prefix, reason })
            .collect(),
        capabilities: CapabilitiesExport {
            ids: PeerHostCapability::ALL.iter().map(|c| c.key()).collect(),
            desktop: advertised_by(PeerHostKind::Desktop)
                .iter()
                .map(|c| c.key())
                .collect(),
            cli: advertised_by(PeerHostKind::Cli)
                .iter()
                .map(|c| c.key())
                .collect(),
        },
        operations: operations().to_vec(),
    }
}

/// FNV-1a 64-bit over the canonical JSON of the registry without its digest.
/// A content fingerprint for drift detection, not a security primitive.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Content digest of the registry, shared by every generated projection.
pub fn digest() -> String {
    let canonical = serde_json::to_string(&export_without_digest())
        .expect("remote surface registry must serialize");
    format!("fnv1a64:{:016x}", fnv1a_64(canonical.as_bytes()))
}

/// The full export, including its digest.
pub fn export() -> RemoteSurfaceRegistryExport {
    let mut export = export_without_digest();
    export.digest = digest();
    export
}

/// The export as pretty JSON with a trailing newline, byte-identical to the
/// committed `src/generated/remote-surface-registry.json`.
pub fn export_json() -> String {
    let mut json = serde_json::to_string_pretty(&export())
        .expect("remote surface registry export must serialize");
    json.push('\n');
    json
}

/// The committed export artifact.
pub const GENERATED_REGISTRY_JSON: &str = include_str!("../generated/remote-surface-registry.json");

fn baseline_set(list: &[&'static str]) -> BTreeSet<&'static str> {
    list.iter().copied().collect()
}

/// Names still in the frozen unaudited backlog.
pub fn unaudited_backlog() -> BTreeSet<&'static str> {
    operations()
        .iter()
        .filter(|op| op.remote_workspace == RemoteWorkspaceStance::Unaudited)
        .map(|op| op.id)
        .collect()
}

/// The committed unaudited baseline (ratchet reference).
pub fn unaudited_baseline() -> BTreeSet<&'static str> {
    baseline_set(baseline::UNAUDITED_BASELINE)
}

/// Names the CLI peer host answers with a declared empty or no-op success.
pub fn soft_empty_commands() -> BTreeSet<&'static str> {
    operations()
        .iter()
        .filter(|op| op.cli_peer.is_soft_empty())
        .map(|op| op.id)
        .collect()
}

/// The committed soft-empty baseline (ratchet reference).
pub fn soft_empty_baseline() -> BTreeSet<&'static str> {
    baseline_set(baseline::SOFT_EMPTY_BASELINE)
}

/// Names the CLI peer host runs through a real product handler, excluding the
/// host control plane. The CLI host's dispatch table is checked against this.
pub fn cli_handled_commands() -> BTreeSet<&'static str> {
    operations()
        .iter()
        .filter(|op| op.cli_peer.is_handled() && op.peer != PeerStance::HostControlPlane)
        .map(|op| op.id)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn ops_with<F: Fn(&OperationDefinition) -> bool>(f: F) -> Vec<&'static str> {
        operations()
            .iter()
            .filter(|op| f(op))
            .map(|op| op.id)
            .collect()
    }

    #[test]
    fn operations_are_sorted_and_unique() {
        let ids: Vec<&str> = operations().iter().map(|op| op.id).collect();
        for window in ids.windows(2) {
            assert!(
                window[0] < window[1],
                "registry rows must be sorted by id and unique: {} then {}",
                window[0],
                window[1]
            );
        }
        assert!(
            ids.len() > 600,
            "registry looks truncated: {} rows",
            ids.len()
        );
        for id in &ids {
            assert!(
                id.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_'),
                "operation id must be snake_case: {id}"
            );
        }
    }

    #[test]
    fn lookup_matches_linear_scan() {
        for op in operations() {
            assert_eq!(operation(op.id).map(|found| found.id), Some(op.id));
        }
        assert!(operation("definitely_not_a_command").is_none());
        assert!(operation("").is_none());
    }

    #[test]
    fn generated_registry_json_matches_compiled_registry() {
        assert_eq!(
            GENERATED_REGISTRY_JSON,
            export_json(),
            "src/generated/remote-surface-registry.json is stale; run `pnpm run capabilities:generate`"
        );
        let parsed: Value = serde_json::from_str(GENERATED_REGISTRY_JSON).unwrap();
        assert_eq!(parsed["digest"], Value::String(digest()));
        assert_eq!(
            parsed["schemaVersion"],
            Value::from(REMOTE_SURFACE_SCHEMA_VERSION)
        );
    }

    #[test]
    fn digest_is_stable_for_same_content() {
        assert_eq!(digest(), digest());
        assert!(digest().starts_with("fnv1a64:"));
    }

    #[test]
    fn unaudited_backlog_must_not_grow() {
        let backlog = unaudited_backlog();
        let baseline = unaudited_baseline();
        let added: Vec<_> = backlog.difference(&baseline).collect();
        assert!(
            added.is_empty(),
            "new commands must ship with a real remote-workspace stance, not Unaudited: {added:?}"
        );
    }

    #[test]
    fn unaudited_baseline_must_not_retain_graduated_commands() {
        let backlog = unaudited_backlog();
        let baseline = unaudited_baseline();
        let stale: Vec<_> = baseline.difference(&backlog).collect();
        assert!(
            stale.is_empty(),
            "remove graduated commands from UNAUDITED_BASELINE so the ratchet stays tight: {stale:?}"
        );
    }

    #[test]
    fn unaudited_rows_are_registered_tauri_commands() {
        for op in operations() {
            if op.remote_workspace == RemoteWorkspaceStance::Unaudited {
                assert_eq!(
                    op.surface,
                    OperationSurface::TauriCommand,
                    "{} is HostInvoke-only and must carry an explicit stance",
                    op.id
                );
            }
        }
    }

    #[test]
    fn soft_empty_backlog_must_not_grow_or_retain_graduated_commands() {
        let live = soft_empty_commands();
        let baseline = soft_empty_baseline();
        let added: Vec<_> = live.difference(&baseline).collect();
        assert!(
            added.is_empty(),
            "a new empty CLI answer needs a reviewed reason and a baseline entry: {added:?}"
        );
        let stale: Vec<_> = baseline.difference(&live).collect();
        assert!(
            stale.is_empty(),
            "remove from SOFT_EMPTY_BASELINE: {stale:?}"
        );
    }

    #[test]
    fn controller_local_and_operator_only_rows_use_refused_cli_support() {
        for op in operations() {
            if op.is_refused_by_peer_hosts() {
                assert_eq!(
                    op.cli_peer,
                    table::REFUSED,
                    "{} is refused before dispatch; its CLI cell must be REFUSED",
                    op.id
                );
            } else {
                assert_ne!(
                    op.cli_peer,
                    table::REFUSED,
                    "{} is not refused before dispatch; REFUSED is not a real support cell",
                    op.id
                );
            }
        }
    }

    #[test]
    fn host_control_plane_rows_execute_on_both_hosts() {
        let control_plane = ops_with(|op| op.peer == PeerStance::HostControlPlane);
        assert!(control_plane.contains(&"peer_control_attach"));
        assert!(control_plane.contains(&"peer_control_detach"));
        assert!(control_plane.contains(&"peer_mode_ping"));
        assert_eq!(
            control_plane
                .iter()
                .filter(|id| id.starts_with("dispatch_target_"))
                .count(),
            15
        );
        for id in control_plane {
            let op = operation(id).unwrap();
            assert!(op.cli_peer.is_handled(), "{id} must be handled on CLI");
            assert!(
                op.host_support(PeerHostKind::Desktop).is_handled(),
                "{id} must be handled on desktop"
            );
            assert_eq!(
                peer_host_verdict(id, PeerHostKind::Cli),
                PeerHostVerdict::HostControlPlane
            );
            assert_eq!(
                peer_host_verdict(id, PeerHostKind::Desktop),
                PeerHostVerdict::HostControlPlane
            );
        }
        let dispatch_targets = ops_with(|op| op.id.starts_with("dispatch_target_"));
        for id in dispatch_targets {
            assert_eq!(
                operation(id).unwrap().peer,
                PeerStance::HostControlPlane,
                "{id} must be routed to the dispatch runner before the peer bridge"
            );
        }
    }

    #[test]
    fn controller_local_derivation_matches_known_anchors() {
        let local: BTreeSet<&str> = controller_local_commands().collect();
        for anchor in [
            "show_main_window",
            "account_login",
            "account_github_start",
            "account_github_poll",
            "account_github_info",
            "account_logout",
            "peer_mode_ping",
            "dispatch_submit",
            "mark_openbitfun_control_surface_ready",
        ] {
            assert!(
                local.contains(anchor),
                "{anchor} must stay controller-local"
            );
        }
        assert!(
            !local.contains("git_trust_repository"),
            "git_trust_repository is OperatorOnly: forwarded so the peer's refusal is explicit"
        );
        assert_eq!(
            operation("git_trust_repository").unwrap().peer,
            PeerStance::OperatorOnly
        );
        for op in operations() {
            if op.surface == OperationSurface::HostInvokeOnly {
                assert!(
                    !local.contains(op.id),
                    "{} is HostInvoke-only and must not enter the frontend local set",
                    op.id
                );
            }
        }
        assert!(!local.contains("start_dialog_turn"));
        assert!(!local.contains("product_control_invoke"));
    }

    #[test]
    fn refusal_messages_keep_legacy_wire_strings() {
        assert_eq!(
            PeerRefusal::ControllerLocal.message("account_login"),
            "command 'account_login' is local-only and cannot run on peer"
        );
        assert_eq!(
            PeerRefusal::Retired {
                reason: retired_reason("lsp_open").unwrap()
            }
            .message("lsp_open"),
            "command 'lsp_open' is unsupported because the OpenBitFun LSP runtime has been retired"
        );
        let cli = PeerRefusal::HostUnsupported {
            host: PeerHostKind::Cli,
            reason: "x",
        }
        .message("terminal_list");
        assert!(cli.starts_with("command 'terminal_list' is not supported on CLI peer host"));
        assert!(!PeerRefusal::UnknownToHost {
            host: PeerHostKind::Cli
        }
        .message("nope")
        .contains("is not supported on CLI peer host"));
        assert_eq!(
            PeerRefusal::EmptyCommand.message(""),
            "HostInvoke command is empty"
        );
    }

    #[test]
    fn verdicts_follow_the_host_order() {
        assert_eq!(
            peer_host_verdict("", PeerHostKind::Cli),
            PeerHostVerdict::Refuse(PeerRefusal::EmptyCommand)
        );
        assert!(matches!(
            peer_host_verdict("lsp_anything", PeerHostKind::Desktop),
            PeerHostVerdict::Refuse(PeerRefusal::Retired { .. })
        ));
        assert!(retired_reason("custom_lsp_wrapper").is_none());
        assert_eq!(
            peer_host_verdict("account_login", PeerHostKind::Cli),
            PeerHostVerdict::Refuse(PeerRefusal::ControllerLocal)
        );
        assert_eq!(
            peer_host_verdict("git_trust_repository", PeerHostKind::Desktop),
            PeerHostVerdict::Refuse(PeerRefusal::ControllerLocal)
        );
        assert_eq!(
            peer_host_verdict("start_dialog_turn", PeerHostKind::Cli),
            PeerHostVerdict::Execute
        );
        assert_eq!(
            peer_host_verdict("start_dialog_turn", PeerHostKind::Desktop),
            PeerHostVerdict::Execute
        );
        assert_eq!(
            peer_host_verdict("list_miniapps", PeerHostKind::Cli),
            PeerHostVerdict::Execute,
            "declared soft-empty answers execute"
        );
        assert_eq!(
            peer_host_verdict("terminal_list", PeerHostKind::Cli),
            PeerHostVerdict::Execute
        );
        assert!(matches!(
            peer_host_verdict("worktree_list", PeerHostKind::Cli),
            PeerHostVerdict::Refuse(PeerRefusal::HostUnsupported {
                host: PeerHostKind::Cli,
                ..
            })
        ));
        assert!(matches!(
            peer_host_verdict("browser_control_launch", PeerHostKind::Cli),
            PeerHostVerdict::Refuse(PeerRefusal::HostUnsupported { .. })
        ));
        assert_eq!(
            peer_host_verdict("browser_control_launch", PeerHostKind::Desktop),
            PeerHostVerdict::Execute
        );
        assert_eq!(
            peer_host_verdict("get_workspace_info", PeerHostKind::Cli),
            PeerHostVerdict::Execute,
            "CLI alias stays handled for older controllers"
        );
        assert!(matches!(
            peer_host_verdict("get_workspace_info", PeerHostKind::Desktop),
            PeerHostVerdict::Refuse(PeerRefusal::HostUnsupported {
                host: PeerHostKind::Desktop,
                ..
            })
        ));
        assert_eq!(
            peer_host_verdict("not_a_real_command", PeerHostKind::Cli),
            PeerHostVerdict::Refuse(PeerRefusal::UnknownToHost {
                host: PeerHostKind::Cli
            })
        );
    }

    #[test]
    fn every_unsupported_row_has_a_reason() {
        for op in operations() {
            if let HostSupport::Unsupported { reason } | HostSupport::SoftEmpty { reason } =
                op.cli_peer
            {
                assert!(!reason.trim().is_empty(), "{} has an empty reason", op.id);
            }
            if let PeerStance::Retired { reason } = op.peer {
                assert!(
                    !reason.trim().is_empty(),
                    "{} has an empty retired reason",
                    op.id
                );
            }
        }
    }

    #[test]
    fn whole_session_copy_runs_on_desktop_and_is_explicitly_unsupported_on_cli() {
        let copy = operation("copy_session").unwrap();
        assert_eq!(copy.remote_workspace, RemoteWorkspaceStance::Routed);
        assert_eq!(copy.peer, PeerStance::Proxied);
        assert_eq!(
            peer_host_verdict("copy_session", PeerHostKind::Desktop),
            PeerHostVerdict::Execute
        );
        assert!(matches!(
            peer_host_verdict("copy_session", PeerHostKind::Cli),
            PeerHostVerdict::Refuse(PeerRefusal::HostUnsupported { .. })
        ));
    }

    #[test]
    fn remote_workspace_stance_keeps_historical_policy_names() {
        for (stance, expected) in [
            (RemoteWorkspaceStance::Routed, "RemoteRouted"),
            (RemoteWorkspaceStance::Unsupported, "RemoteUnsupported"),
            (RemoteWorkspaceStance::LocalOnly, "LocalOnly"),
            (RemoteWorkspaceStance::Agnostic, "WorkspaceAgnostic"),
            (RemoteWorkspaceStance::Unaudited, "LegacyUnaudited"),
        ] {
            assert_eq!(
                serde_json::to_value(stance).unwrap(),
                Value::String(expected.into())
            );
            let back: RemoteWorkspaceStance =
                serde_json::from_value(Value::String(expected.into())).unwrap();
            assert_eq!(back, stance);
        }
    }

    #[test]
    fn semantic_anchors_hold() {
        let stance = |id: &str| operation(id).unwrap().remote_workspace;
        assert_eq!(
            stance("get_token_usage_statistics"),
            RemoteWorkspaceStance::Agnostic
        );
        assert_eq!(
            stance("confirm_frontend_update"),
            RemoteWorkspaceStance::LocalOnly
        );
        assert_eq!(
            stance("apply_external_mcp_import_command"),
            RemoteWorkspaceStance::Unsupported
        );
        assert_eq!(
            stance("get_directory_children"),
            RemoteWorkspaceStance::Routed
        );
        assert_eq!(
            operation("get_workspace_info").unwrap().surface,
            OperationSurface::HostInvokeOnly
        );
        assert_eq!(
            operation("list_files").unwrap().remote_workspace,
            stance("get_directory_children"),
            "the CLI alias inherits the canonical command's stance"
        );
        for alias in [
            "get_workspace_info",
            "list_persisted_sessions_count",
            "rename_session",
        ] {
            assert_eq!(
                operation(alias).unwrap().remote_workspace,
                RemoteWorkspaceStance::Agnostic,
                "{alias} is a CLI metadata alias and carries an explicit stance"
            );
        }
    }
}
