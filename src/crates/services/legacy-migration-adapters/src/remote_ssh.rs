use super::common::{
    backup_domain_dir, backup_file_once, io_error, read_bounded_json, read_optional_bounded_json,
    relative_display, restore_unverified_file, stage_domain_dir, validate_regular_file,
    MAX_JSON_BYTES,
};
use openbitfun_legacy_migration::{
    atomic_write_json, DomainContext, DomainScan, LegacyDomainAdapter, LegacyMigrationError,
    LegacyMigrationResult, MigrationRoots,
};
use openbitfun_product_domains::legacy_migration::{
    ConflictResolution, FindingSeverity, MigrationConflict, MigrationDiagnostic, MigrationDomainId,
    MigrationDomainResult, MigrationDomainState, ScanFinding,
};
use openbitfun_services_core::workspace_identity::canonical_ssh_connection_id as canonical_connection_id;
use openbitfun_services_integrations::remote_persistence as owner;
use owner::{
    KnownHostRecord, RemoteWorkspaceRecord, SavedAuthTypeRecord, SavedConnectionRecord,
    SshVaultRecord,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const DOMAIN_DIR: &str = "remote-ssh";
const SOURCE_SCHEMA: &str = "bitfun.remote-ssh.v0.2.19";
const TARGET_SCHEMA: &str = "openbitfun.remote-ssh.current";
const FILES: [&str; 5] = [
    "ssh_connections.json",
    "remote_workspace.json",
    "known_hosts",
    ".ssh_password_vault.key",
    "ssh_password_vault.json",
];
const MAX_VAULT_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) struct RemoteSshAdapter;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum VaultHealth {
    #[default]
    Absent,
    Valid,
    Invalid,
}

struct SshState {
    omitted: Vec<String>,
    files: BTreeMap<String, String>,
    connections: Vec<SavedConnectionRecord>,
    workspaces: Vec<RemoteWorkspaceRecord>,
    known_hosts: Vec<KnownHostRecord>,
    vault_health: VaultHealth,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ProfileOrigin {
    Source,
    Target,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultSource {
    origin: ProfileOrigin,
    original_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteSshManifest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    omitted: Vec<String>,
    source_files: BTreeMap<String, String>,
    target_before: BTreeMap<String, Option<String>>,
    staged_files: BTreeMap<String, String>,
    vault_sources: BTreeMap<String, VaultSource>,
    source_vault_health: VaultHealth,
    target_vault_health: VaultHealth,
    imported: u64,
    skipped: u64,
    conflicts: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RemoteSshReceipt {
    manifest_digest: String,
    completed: bool,
    post_files: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RemoteSshOutcome {
    imported: u64,
    skipped: u64,
    conflicts: u64,
    warnings: Vec<MigrationDiagnostic>,
    requires_reauthentication: Vec<String>,
    requires_relocation: Vec<String>,
}

struct MergePlan {
    connections: Vec<SavedConnectionRecord>,
    workspaces: Vec<RemoteWorkspaceRecord>,
    known_hosts: Vec<KnownHostRecord>,
    vault_sources: BTreeMap<String, VaultSource>,
    conflicts: Vec<MigrationConflict>,
    imported: u64,
    skipped: u64,
}

impl LegacyDomainAdapter for RemoteSshAdapter {
    fn domain(&self) -> MigrationDomainId {
        MigrationDomainId::RemoteSsh
    }

    fn scan(&self, roots: &MigrationRoots) -> LegacyMigrationResult<DomainScan> {
        let source = read_state(&roots.legacy_ssh_root, true)?;
        let target = read_state(&roots.target_ssh_root, false)?;
        let merged = merge_states(&source, &target);
        Ok(DomainScan {
            finding: ScanFinding {
                domain: self.domain(),
                code: if !source.omitted.is_empty() {
                    "remote_items_skipped".to_string()
                } else if source.files.is_empty() {
                    "legacy_remote_ssh_absent".to_string()
                } else {
                    "legacy_remote_ssh_supported".to_string()
                },
                severity: if merged.conflicts.is_empty()
                    && source.omitted.is_empty()
                    && source.vault_health != VaultHealth::Invalid
                {
                    FindingSeverity::Info
                } else {
                    FindingSeverity::Warning
                },
                entity_count: (source.connections.len()
                    + source.workspaces.len()
                    + source.known_hosts.len()) as u64,
                logical_bytes: total_bytes(&roots.legacy_ssh_root, source.files.keys())?,
                source_schema: Some(SOURCE_SCHEMA.to_string()),
                migratable: true,
                detail: "Legacy SSH profiles, POSIX workspace registrations, host trust, and credential references were inspected as one atomic subdomain.".to_string(),
            },
            conflicts: merged.conflicts,
            target_schema: Some(TARGET_SCHEMA.to_string()),
            dependencies: Vec::new(),
        })
    }

    fn stage(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<MigrationDomainResult> {
        reset_stage(context)?;
        let source = read_state(&context.roots.legacy_ssh_root, true)?;
        let target = read_state(&context.roots.target_ssh_root, false)?;
        let merged = merge_states(&source, &target);
        let domain_root = stage_domain_dir(context, DOMAIN_DIR);
        owner::write_saved_connections(
            &domain_root.join("ssh_connections.json"),
            &merged.connections,
        )
        .map_err(owner_error)?;
        owner::write_remote_workspaces(
            &domain_root.join("remote_workspace.json"),
            &merged.workspaces,
        )
        .map_err(owner_error)?;
        owner::write_known_hosts(&domain_root.join("known_hosts"), &merged.known_hosts)
            .map_err(owner_error)?;
        let staged_files = [
            "ssh_connections.json",
            "remote_workspace.json",
            "known_hosts",
        ]
        .into_iter()
        .map(|relative| {
            let path = domain_root.join(relative);
            Ok((relative.to_string(), file_digest(&path)?))
        })
        .collect::<LegacyMigrationResult<BTreeMap<_, _>>>()?;
        let target_before = FILES
            .into_iter()
            .map(|relative| (relative.to_string(), target.files.get(relative).cloned()))
            .collect();
        let manifest = RemoteSshManifest {
            omitted: source.omitted,
            source_files: source.files,
            target_before,
            staged_files,
            vault_sources: merged.vault_sources,
            source_vault_health: source.vault_health,
            target_vault_health: target.vault_health,
            imported: merged.imported,
            skipped: merged.skipped,
            conflicts: merged.conflicts.len() as u64,
        };
        atomic_write_json(&manifest_path(context), &manifest)?;
        Ok(MigrationDomainResult {
            domain: self.domain(),
            state: MigrationDomainState::Staged,
            imported: manifest.imported,
            skipped: manifest.skipped,
            conflicts: manifest.conflicts,
            warnings: manifest
                .omitted
                .iter()
                .map(|path| skipped_warning(path))
                .collect(),
            ..MigrationDomainResult::default()
        })
    }

    fn validate_stage(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_manifest(context)?;
        let source = read_state(&context.roots.legacy_ssh_root, true)?;
        if source.files != manifest.source_files
            || source.vault_health != manifest.source_vault_health
        {
            return Err(LegacyMigrationError::InvalidRequest(
                "legacy SSH inputs changed after staging".to_string(),
            ));
        }
        if let Some(receipt) = read_optional_bounded_json::<RemoteSshReceipt>(
            &context.layout.stage_root(),
            &receipt_path(context),
        )? {
            if receipt.manifest_digest != json_digest(&manifest)? {
                return Err(LegacyMigrationError::InvalidRequest(
                    "SSH commit receipt does not match its staged manifest".to_string(),
                ));
            }
            return validate_staged_files(context, &manifest);
        }
        if current_files(&context.roots.target_ssh_root)? != manifest.target_before {
            return Err(LegacyMigrationError::InvalidRequest(
                "current SSH data changed after staging".to_string(),
            ));
        }
        validate_staged_files(context, &manifest)
    }

    fn commit(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_manifest(context)?;
        validate_staged_files(context, &manifest)?;
        let manifest_digest = json_digest(&manifest)?;
        let receipt = read_optional_bounded_json::<RemoteSshReceipt>(
            &context.layout.stage_root(),
            &receipt_path(context),
        )?;
        if let Some(receipt) = &receipt {
            if receipt.manifest_digest != manifest_digest {
                return Err(LegacyMigrationError::InvalidRequest(
                    "SSH commit receipt does not match its manifest".to_string(),
                ));
            }
            if receipt.completed
                && current_files(&context.roots.target_ssh_root)? == receipt.post_files
            {
                return Ok(());
            }
        } else {
            if current_files(&context.roots.target_ssh_root)? != manifest.target_before {
                return Err(LegacyMigrationError::InvalidRequest(
                    "current SSH data changed before commit".to_string(),
                ));
            }
            backup_targets(context, &manifest.target_before)?;
            atomic_write_json(
                &receipt_path(context),
                &RemoteSshReceipt {
                    manifest_digest: manifest_digest.clone(),
                    completed: false,
                    post_files: BTreeMap::new(),
                },
            )?;
        }
        let source = read_state(&context.roots.legacy_ssh_root, true)?;
        if source.files != manifest.source_files {
            return Err(LegacyMigrationError::InvalidRequest(
                "legacy SSH inputs changed during commit".to_string(),
            ));
        }
        let original = read_state(&backup_domain_dir(context, DOMAIN_DIR), false)?;
        let staged = read_staged(context)?;
        let mut outcome = RemoteSshOutcome {
            imported: manifest.imported,
            skipped: manifest.skipped,
            conflicts: manifest.conflicts,
            warnings: manifest
                .omitted
                .iter()
                .map(|path| skipped_warning(path))
                .collect(),
            ..RemoteSshOutcome::default()
        };
        if manifest.conflicts > 0 {
            outcome.warnings.push(warning(
                "ssh_conflicts_require_review",
                "One or more SSH target records won or require explicit host-key review.",
            ));
        }
        if manifest.source_files.is_empty() {
            let post_files = current_files(&context.roots.target_ssh_root)?;
            atomic_write_json(&outcome_path(context), &outcome)?;
            return atomic_write_json(
                &receipt_path(context),
                &RemoteSshReceipt {
                    manifest_digest,
                    completed: true,
                    post_files,
                },
            );
        }
        fs::create_dir_all(&context.roots.target_ssh_root)
            .map_err(|error| io_error(&context.roots.target_ssh_root, error))?;
        owner::write_saved_connections(
            &context.roots.target_ssh_root.join("ssh_connections.json"),
            &staged.connections,
        )
        .map_err(owner_error)?;
        owner::write_remote_workspaces(
            &context.roots.target_ssh_root.join("remote_workspace.json"),
            &staged.workspaces,
        )
        .map_err(owner_error)?;
        owner::write_known_hosts(
            &context.roots.target_ssh_root.join("known_hosts"),
            &staged.known_hosts,
        )
        .map_err(owner_error)?;
        migrate_vault(
            context,
            &source,
            &original,
            &staged.connections,
            &manifest,
            &mut outcome,
        )?;
        record_unavailable_workspace_references(&staged, &mut outcome);
        let post_files = current_files(&context.roots.target_ssh_root)?;
        atomic_write_json(&outcome_path(context), &outcome)?;
        atomic_write_json(
            &receipt_path(context),
            &RemoteSshReceipt {
                manifest_digest,
                completed: true,
                post_files,
            },
        )
    }

    fn validate_commit(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let receipt: RemoteSshReceipt =
            read_bounded_json(&context.layout.stage_root(), &receipt_path(context))?;
        if !receipt.completed
            || current_files(&context.roots.target_ssh_root)? != receipt.post_files
        {
            return Err(LegacyMigrationError::InvalidRequest(
                "current SSH owner did not retain the committed data".to_string(),
            ));
        }
        let current = read_state(&context.roots.target_ssh_root, false)?;
        if current.vault_health == VaultHealth::Invalid {
            // A pre-existing invalid target vault is retained rather than
            // overwritten. Its affected profiles are reported for repair.
            let original = read_manifest(context)?;
            if original.target_vault_health != VaultHealth::Invalid {
                return Err(LegacyMigrationError::InvalidRequest(
                    "committed SSH password vault is not readable".to_string(),
                ));
            }
        }
        Ok(())
    }

    fn finalize_result(
        &self,
        context: &DomainContext<'_>,
        staged: &MigrationDomainResult,
    ) -> LegacyMigrationResult<MigrationDomainResult> {
        let outcome: RemoteSshOutcome =
            read_bounded_json(&context.layout.stage_root(), &outcome_path(context))?;
        let mut result = staged.clone();
        result.imported = outcome.imported;
        result.skipped = outcome.skipped;
        result.conflicts = outcome.conflicts;
        result.warnings = outcome.warnings;
        result.requires_reauthentication = outcome.requires_reauthentication;
        result.requires_relocation = outcome.requires_relocation;
        Ok(result)
    }

    fn rollback_unverified(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let Some(manifest) = read_optional_bounded_json::<RemoteSshManifest>(
            &context.layout.stage_root(),
            &manifest_path(context),
        )?
        else {
            return Ok(());
        };
        let backup_root = backup_domain_dir(context, DOMAIN_DIR);
        for (relative, digest) in &manifest.target_before {
            restore_unverified_file(
                &context.roots.target_ssh_root.join(relative),
                &backup_root.join(relative),
                digest.is_some(),
            )?;
        }
        Ok(())
    }
}

fn read_state(root: &Path, legacy: bool) -> LegacyMigrationResult<SshState> {
    let mut files = BTreeMap::new();
    let mut omitted = Vec::new();
    for relative in FILES {
        let path = root.join(relative);
        let inspected = (|| -> LegacyMigrationResult<Option<String>> {
            if existing_regular(
                root,
                &path,
                if relative.contains("vault") {
                    MAX_VAULT_BYTES
                } else {
                    MAX_JSON_BYTES
                },
            )? {
                Ok(Some(file_digest(&path)?))
            } else {
                Ok(None)
            }
        })();
        match inspected {
            Ok(Some(digest)) => {
                files.insert(relative.to_string(), digest);
            }
            Ok(None) => {}
            Err(_) if legacy => omitted.push(relative.to_string()),
            Err(error) => return Err(error),
        }
    }

    let connections = if legacy {
        read_source_records(
            root,
            "ssh_connections.json",
            false,
            &mut omitted,
            |v: &SavedConnectionRecord| v.validate().is_ok(),
        )
    } else if files.contains_key("ssh_connections.json") {
        owner::read_saved_connections(&root.join("ssh_connections.json"))
            .map_err(owner_error)?
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let workspaces = if legacy {
        read_source_records(
            root,
            "remote_workspace.json",
            true,
            &mut omitted,
            |v: &RemoteWorkspaceRecord| {
                !v.connection_id.trim().is_empty() && v.remote_path.starts_with('/')
            },
        )
    } else if files.contains_key("remote_workspace.json") {
        if legacy {
            owner::read_legacy_remote_workspaces(&root.join("remote_workspace.json"))
        } else {
            owner::read_current_remote_workspaces(&root.join("remote_workspace.json"))
        }
        .map_err(owner_error)?
        .unwrap_or_default()
    } else {
        Vec::new()
    };
    let known_hosts = if legacy {
        read_source_records(
            root,
            "known_hosts",
            false,
            &mut omitted,
            |v: &KnownHostRecord| {
                v.port != 0
                    && [&v.host, &v.key_type, &v.fingerprint, &v.public_key]
                        .iter()
                        .all(|s| !s.trim().is_empty())
            },
        )
    } else if files.contains_key("known_hosts") {
        owner::read_known_hosts(&root.join("known_hosts"))
            .map_err(owner_error)?
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    let vault_health = if files.contains_key(".ssh_password_vault.key")
        || files.contains_key("ssh_password_vault.json")
    {
        match owner::read_ssh_vault(root) {
            Ok(Some(_)) => VaultHealth::Valid,
            Ok(None) => VaultHealth::Absent,
            Err(_) => VaultHealth::Invalid,
        }
    } else {
        VaultHealth::Absent
    };
    Ok(SshState {
        omitted,
        files,
        connections,
        workspaces,
        known_hosts,
        vault_health,
    })
}

fn merge_states(source: &SshState, target: &SshState) -> MergePlan {
    let mut conflicts = Vec::new();
    let mut imported = 0u64;
    let mut skipped = source.omitted.len() as u64;
    let mut connections = Vec::new();
    let mut vault_sources = BTreeMap::new();
    let mut target_ids = BTreeSet::new();
    let mut source_id_map = BTreeMap::new();
    let mut target_id_map = BTreeMap::new();

    for connection in &target.connections {
        let mut connection = connection.clone();
        let original_id = connection.id.clone();
        connection.id = canonical_connection_id(&connection.id);
        target_id_map.insert(original_id.clone(), connection.id.clone());
        if target_ids.insert(connection.id.clone()) {
            vault_sources.insert(
                connection.id.clone(),
                VaultSource {
                    origin: ProfileOrigin::Target,
                    original_id,
                },
            );
            connections.push(connection);
        }
    }
    for connection in &source.connections {
        let mut connection = connection.clone();
        let original_id = connection.id.clone();
        connection.id = canonical_connection_id(&connection.id);
        source_id_map.insert(original_id.clone(), connection.id.clone());
        if target_ids.insert(connection.id.clone()) {
            imported = imported.saturating_add(1);
            vault_sources.insert(
                connection.id.clone(),
                VaultSource {
                    origin: ProfileOrigin::Source,
                    original_id,
                },
            );
            connections.push(connection);
        } else {
            skipped = skipped.saturating_add(1);
            conflicts.push(MigrationConflict {
                domain: MigrationDomainId::RemoteSsh,
                code: "ssh_connection_target_wins".to_string(),
                source_summary: "legacy SSH connection".to_string(),
                target_summary: "current SSH connection with the same stable id".to_string(),
                resolution: ConflictResolution::TargetWins,
            });
        }
    }

    let mut workspace_keys = BTreeSet::new();
    let mut workspaces = Vec::new();
    for (origin, values, mapping) in [
        (ProfileOrigin::Target, &target.workspaces, &target_id_map),
        (ProfileOrigin::Source, &source.workspaces, &source_id_map),
    ] {
        for workspace in values {
            let mut workspace = workspace.clone();
            workspace.connection_id = mapping
                .get(&workspace.connection_id)
                .cloned()
                .unwrap_or_else(|| canonical_connection_id(&workspace.connection_id));
            let key = (
                workspace.connection_id.clone(),
                workspace.remote_path.clone(),
            );
            if workspace_keys.insert(key) {
                if origin == ProfileOrigin::Source {
                    imported = imported.saturating_add(1);
                }
                workspaces.push(workspace);
            } else if origin == ProfileOrigin::Source {
                skipped = skipped.saturating_add(1);
            }
        }
    }

    let mut known_hosts_by_key = BTreeMap::<(String, u16), KnownHostRecord>::new();
    for host in &target.known_hosts {
        known_hosts_by_key.insert((host.host.clone(), host.port), host.clone());
    }
    for host in &source.known_hosts {
        let key = (host.host.clone(), host.port);
        match known_hosts_by_key.get(&key) {
            None => {
                known_hosts_by_key.insert(key, host.clone());
                imported = imported.saturating_add(1);
            }
            Some(existing)
                if existing.fingerprint == host.fingerprint
                    && existing.public_key == host.public_key =>
            {
                skipped = skipped.saturating_add(1);
            }
            Some(existing) => {
                skipped = skipped.saturating_add(1);
                conflicts.push(MigrationConflict {
                    domain: MigrationDomainId::RemoteSsh,
                    code: "ssh_known_host_conflict".to_string(),
                    source_summary: format!("legacy fingerprint {}", host.fingerprint),
                    target_summary: format!("current fingerprint {}", existing.fingerprint),
                    resolution: ConflictResolution::RequiresUserAction,
                });
            }
        }
    }
    MergePlan {
        connections,
        workspaces,
        known_hosts: known_hosts_by_key.into_values().collect(),
        vault_sources,
        conflicts,
        imported,
        skipped,
    }
}

fn migrate_vault(
    context: &DomainContext<'_>,
    source: &SshState,
    original: &SshState,
    connections: &[SavedConnectionRecord],
    manifest: &RemoteSshManifest,
    outcome: &mut RemoteSshOutcome,
) -> LegacyMigrationResult<()> {
    let source_vault = if source.vault_health == VaultHealth::Valid {
        owner::read_ssh_vault(&context.roots.legacy_ssh_root).map_err(owner_error)?
    } else {
        None
    };
    let original_root = backup_domain_dir(context, DOMAIN_DIR);
    let target_vault = if original.vault_health == VaultHealth::Valid {
        owner::read_ssh_vault(&original_root).map_err(owner_error)?
    } else {
        None
    };
    if original.vault_health == VaultHealth::Invalid {
        for connection in connections
            .iter()
            .filter(|connection| needs_password(connection))
        {
            require_ssh_reauthentication(outcome, &connection.id, "target_ssh_vault_unavailable");
        }
        outcome.warnings.push(warning(
            "target_ssh_vault_unavailable",
            "The existing SSH password vault was retained unchanged because the current owner could not read it.",
        ));
        return Ok(());
    }

    let mut output = target_vault.unwrap_or_else(owner::new_ssh_vault);
    let mut changed = false;
    for connection in connections
        .iter()
        .filter(|connection| needs_password(connection))
    {
        let Some(source_ref) = manifest.vault_sources.get(&connection.id) else {
            require_ssh_reauthentication(outcome, &connection.id, "ssh_password_reference_missing");
            continue;
        };
        let already_present = output
            .decrypt(&connection.id)
            .map_err(owner_error)?
            .is_some();
        if already_present {
            continue;
        }
        let credential = match source_ref.origin {
            ProfileOrigin::Target => {
                target_vault_entry(&output, &source_ref.original_id, &connection.id)
                    .map_err(owner_error)?
            }
            ProfileOrigin::Source => source_vault
                .as_ref()
                .map(|vault| vault.decrypt(&source_ref.original_id))
                .transpose()
                .map_err(owner_error)?
                .flatten(),
        };
        if let Some(credential) = credential {
            output
                .store(connection.id.clone(), &credential)
                .map_err(owner_error)?;
            if source_ref.origin == ProfileOrigin::Target && source_ref.original_id != connection.id
            {
                output.remove(&source_ref.original_id);
            }
            changed = true;
        } else {
            require_ssh_reauthentication(outcome, &connection.id, "ssh_password_unavailable");
        }
    }
    if source.vault_health == VaultHealth::Invalid {
        outcome.warnings.push(warning(
            "legacy_ssh_vault_unavailable",
            "SSH profiles and workspaces were retained, but one or more legacy passwords could not be transferred.",
        ));
    }
    if changed || original.vault_health == VaultHealth::Valid {
        owner::write_ssh_vault(&context.roots.target_ssh_root, &output).map_err(owner_error)?;
    }
    Ok(())
}

fn target_vault_entry(
    vault: &SshVaultRecord,
    original_id: &str,
    canonical_id: &str,
) -> anyhow::Result<Option<String>> {
    if original_id == canonical_id {
        return vault.decrypt(canonical_id);
    }
    vault.decrypt(original_id)
}

fn needs_password(connection: &SavedConnectionRecord) -> bool {
    matches!(connection.auth_type, SavedAuthTypeRecord::Password)
        && connection
            .container
            .as_ref()
            .is_none_or(|container| !container.local)
}

fn require_ssh_reauthentication(outcome: &mut RemoteSshOutcome, id: &str, code: &str) {
    outcome.requires_reauthentication.push(id.to_string());
    outcome.warnings.push(MigrationDiagnostic {
        code: code.to_string(),
        severity: FindingSeverity::Warning,
        domain: Some(MigrationDomainId::RemoteSsh),
        message: "An SSH profile was retained but requires credential re-entry.".to_string(),
        action: Some("Enter the credential again before reconnecting".to_string()),
        ..MigrationDiagnostic::default()
    });
}

fn record_unavailable_workspace_references(state: &SshState, outcome: &mut RemoteSshOutcome) {
    let connection_ids = state
        .connections
        .iter()
        .map(|connection| connection.id.as_str())
        .collect::<BTreeSet<_>>();
    for workspace in &state.workspaces {
        if !connection_ids.contains(workspace.connection_id.as_str()) {
            outcome
                .requires_relocation
                .push(workspace.connection_id.clone());
            outcome.warnings.push(warning(
                "ssh_workspace_profile_missing",
                "A remote workspace was retained without silently falling back to a local path, but its SSH profile needs repair.",
            ));
        }
    }
}

fn read_staged(context: &DomainContext<'_>) -> LegacyMigrationResult<SshState> {
    read_state(&stage_domain_dir(context, DOMAIN_DIR), false)
}

fn validate_staged_files(
    context: &DomainContext<'_>,
    manifest: &RemoteSshManifest,
) -> LegacyMigrationResult<()> {
    let staged = read_staged(context)?;
    let actual = [
        "ssh_connections.json",
        "remote_workspace.json",
        "known_hosts",
    ]
    .into_iter()
    .map(|relative| {
        let path = stage_domain_dir(context, DOMAIN_DIR).join(relative);
        Ok((relative.to_string(), file_digest(&path)?))
    })
    .collect::<LegacyMigrationResult<BTreeMap<_, _>>>()?;
    if actual != manifest.staged_files
        || staged.files.len() != 3
        || staged.vault_health != VaultHealth::Absent
    {
        return Err(LegacyMigrationError::InvalidRequest(
            "staged SSH owner data differs from its manifest".to_string(),
        ));
    }
    Ok(())
}

fn current_files(root: &Path) -> LegacyMigrationResult<BTreeMap<String, Option<String>>> {
    FILES
        .into_iter()
        .map(|relative| {
            let path = root.join(relative);
            let digest = match fs::symlink_metadata(&path) {
                Ok(_) => {
                    validate_regular_file(root, &path)?;
                    Some(file_digest(&path)?)
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                Err(error) => return Err(io_error(&path, error)),
            };
            Ok((relative.to_string(), digest))
        })
        .collect()
}

fn backup_targets(
    context: &DomainContext<'_>,
    target_before: &BTreeMap<String, Option<String>>,
) -> LegacyMigrationResult<()> {
    let backup_root = backup_domain_dir(context, DOMAIN_DIR);
    for (relative, digest) in target_before {
        if digest.is_some() {
            let target = context.roots.target_ssh_root.join(relative);
            let backup = backup_root.join(relative);
            if matches!(
                relative.as_str(),
                ".ssh_password_vault.key" | "ssh_password_vault.json"
            ) {
                if !backup.exists() {
                    let bytes = fs::read(&target).map_err(|error| io_error(&target, error))?;
                    owner::write_private_bytes(&backup, &bytes).map_err(owner_error)?;
                }
            } else {
                backup_file_once(&target, &backup)?;
            }
        }
    }
    Ok(())
}

fn existing_regular(root: &Path, path: &Path, max_bytes: u64) -> LegacyMigrationResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(_) => {
            validate_regular_file(root, path)?;
            let bytes = fs::metadata(path)
                .map_err(|error| io_error(path, error))?
                .len();
            if bytes > max_bytes {
                return Err(LegacyMigrationError::ResourceLimit(format!(
                    "SSH persistence file exceeds {max_bytes} bytes: {}",
                    relative_display(root, path)
                )));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(path, error)),
    }
}

fn file_digest(path: &Path) -> LegacyMigrationResult<String> {
    let bytes = fs::read(path).map_err(|error| io_error(path, error))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn json_digest(value: &impl Serialize) -> LegacyMigrationResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        LegacyMigrationError::InvalidRequest(format!("serialize SSH manifest: {error}"))
    })?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn total_bytes<'a>(
    root: &Path,
    paths: impl IntoIterator<Item = &'a String>,
) -> LegacyMigrationResult<u64> {
    let mut total = 0u64;
    for relative in paths {
        let path = root.join(relative);
        total = total.saturating_add(
            fs::metadata(&path)
                .map_err(|error| io_error(&path, error))?
                .len(),
        );
    }
    Ok(total)
}

fn warning(code: &str, message: &str) -> MigrationDiagnostic {
    MigrationDiagnostic {
        code: code.to_string(),
        severity: FindingSeverity::Warning,
        domain: Some(MigrationDomainId::RemoteSsh),
        message: message.to_string(),
        action: Some("Review the SSH profile before reconnecting".to_string()),
        ..MigrationDiagnostic::default()
    }
}

fn owner_error(error: anyhow::Error) -> LegacyMigrationError {
    LegacyMigrationError::InvalidRequest(format!(
        "Remote SSH persistence owner rejected the data: {error:#}"
    ))
}

fn reset_stage(context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
    let path = stage_domain_dir(context, DOMAIN_DIR);
    match fs::remove_dir_all(&path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error(&path, error)),
    }
    fs::create_dir_all(&path).map_err(|error| io_error(&path, error))
}

fn manifest_path(context: &DomainContext<'_>) -> PathBuf {
    stage_domain_dir(context, DOMAIN_DIR).join("manifest.json")
}

fn receipt_path(context: &DomainContext<'_>) -> PathBuf {
    stage_domain_dir(context, DOMAIN_DIR).join("commit-receipt.json")
}

fn outcome_path(context: &DomainContext<'_>) -> PathBuf {
    stage_domain_dir(context, DOMAIN_DIR).join("outcome.json")
}

fn read_manifest(context: &DomainContext<'_>) -> LegacyMigrationResult<RemoteSshManifest> {
    read_bounded_json(&context.layout.stage_root(), &manifest_path(context))
}

fn skipped_warning(path: &str) -> MigrationDiagnostic {
    MigrationDiagnostic {
        severity: FindingSeverity::Warning,
        domain: Some(MigrationDomainId::RemoteSsh),
        code: "remote_items_skipped".into(),
        message: "An unreadable legacy remote record was omitted; other records remain available."
            .into(),
        relative_path: Some(path.into()),
        ..Default::default()
    }
}

fn read_source_records<T: serde::de::DeserializeOwned>(
    root: &Path,
    name: &str,
    singleton: bool,
    omitted: &mut Vec<String>,
    valid: impl Fn(&T) -> bool,
) -> Vec<T> {
    let path = root.join(name);
    if !path.exists() {
        return Vec::new();
    }
    let values = match read_bounded_json::<serde_json::Value>(root, &path) {
        Ok(serde_json::Value::Array(values)) => values,
        Ok(value @ serde_json::Value::Object(_)) if singleton => vec![value],
        _ => {
            omitted.push(name.into());
            return Vec::new();
        }
    };
    values
        .into_iter()
        .enumerate()
        .filter_map(|(index, value)| match serde_json::from_value::<T>(value) {
            Ok(value) if valid(&value) => Some(value),
            _ => {
                omitted.push(format!("{name}/{index}"));
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters_for_groups;
    use openbitfun_legacy_migration::{
        probe_legacy_source, CancellationToken, MigrationEngine, NoCrashInjection, ProbeLimits,
    };
    use openbitfun_product_domains::legacy_migration::{
        MigrationGroupId, MigrationRunStatus, MigrationSelection,
    };

    #[test]
    fn damaged_ssh_records_and_files_leave_valid_profiles_available() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let connection = serde_json::json!({"id":"good","name":"Good","host":"host","port":22,"username":"user","authType":{"type":"Password"}});
        atomic_write_json(
            &root.join("ssh_connections.json"),
            &serde_json::json!([connection, {"id":1}]),
        )
        .unwrap();
        fs::write(root.join("known_hosts"), b"broken JSON").unwrap();
        let source = read_state(root, true).unwrap();
        assert_eq!(source.connections.len(), 1);
        assert_eq!(source.omitted.len(), 2);
        assert!(read_state(root, false).is_err());
        assert_eq!(fs::read(root.join("known_hosts")).unwrap(), b"broken JSON");
    }

    #[test]
    fn ssh_merge_rewrites_reference_closure_and_keeps_target_host_key() {
        let temp = test_tempdir("merge");
        let roots = fixture_roots(temp.path());
        seed_probe_source(&roots);
        fs::create_dir_all(&roots.legacy_ssh_root).unwrap();
        fs::create_dir_all(&roots.target_ssh_root).unwrap();
        let source_connection = connection("ssh-user@example.invalid:22");
        owner::write_saved_connections(
            &roots.legacy_ssh_root.join("ssh_connections.json"),
            std::slice::from_ref(&source_connection),
        )
        .unwrap();
        fs::write(
            roots.legacy_ssh_root.join("remote_workspace.json"),
            serde_json::to_vec_pretty(&workspace("ssh-user@example.invalid:22")).unwrap(),
        )
        .unwrap();
        owner::write_known_hosts(
            &roots.legacy_ssh_root.join("known_hosts"),
            &[known_host("SHA256:legacy", "legacy-public-key")],
        )
        .unwrap();
        let mut source_vault = owner::new_ssh_vault();
        source_vault
            .store("ssh-user@example.invalid:22".to_string(), "legacy-password")
            .unwrap();
        owner::write_ssh_vault(&roots.legacy_ssh_root, &source_vault).unwrap();
        owner::write_known_hosts(
            &roots.target_ssh_root.join("known_hosts"),
            &[known_host("SHA256:current", "current-public-key")],
        )
        .unwrap();
        let before = source_hashes(&roots.legacy_ssh_root);

        let report = run_remote_group(&roots);
        assert_eq!(report.status, MigrationRunStatus::CompletedWithWarnings);
        let connections =
            owner::read_saved_connections(&roots.target_ssh_root.join("ssh_connections.json"))
                .unwrap()
                .unwrap();
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].id, "ssh-user@example.invalid");
        let workspaces = owner::read_current_remote_workspaces(
            &roots.target_ssh_root.join("remote_workspace.json"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(workspaces[0].connection_id, "ssh-user@example.invalid");
        assert_eq!(workspaces[0].remote_path, "/srv/project");
        let known_hosts = owner::read_known_hosts(&roots.target_ssh_root.join("known_hosts"))
            .unwrap()
            .unwrap();
        assert_eq!(known_hosts[0].fingerprint, "SHA256:current");
        let vault = owner::read_ssh_vault(&roots.target_ssh_root)
            .unwrap()
            .expect("migrated vault");
        assert_eq!(
            vault
                .decrypt("ssh-user@example.invalid")
                .unwrap()
                .as_deref(),
            Some("legacy-password")
        );
        assert!(vault
            .decrypt("ssh-user@example.invalid:22")
            .unwrap()
            .is_none());
        assert_eq!(source_hashes(&roots.legacy_ssh_root), before);
        let report_json = serde_json::to_string(&report).unwrap();
        assert!(!report_json.contains("legacy-password"));
        assert_stage_redacted(&roots, &report.run_id, "legacy-password");
        let ssh = report
            .domain_results
            .iter()
            .find(|result| result.domain == MigrationDomainId::RemoteSsh)
            .unwrap();
        assert!(ssh.conflicts >= 1);
    }

    #[test]
    fn corrupt_vault_retains_profiles_and_requests_reauthentication() {
        let temp = test_tempdir("corrupt-vault");
        let roots = fixture_roots(temp.path());
        seed_probe_source(&roots);
        fs::create_dir_all(&roots.legacy_ssh_root).unwrap();
        owner::write_saved_connections(
            &roots.legacy_ssh_root.join("ssh_connections.json"),
            &[connection("ssh-user@example.invalid:22")],
        )
        .unwrap();
        fs::write(
            roots.legacy_ssh_root.join(".ssh_password_vault.key"),
            [0u8; 7],
        )
        .unwrap();
        fs::write(
            roots.legacy_ssh_root.join("ssh_password_vault.json"),
            r#"{"entries":{"ssh-user@example.invalid:22":"invalid"}}"#,
        )
        .unwrap();

        let report = run_remote_group(&roots);
        assert_eq!(report.status, MigrationRunStatus::CompletedWithWarnings);
        let connections =
            owner::read_saved_connections(&roots.target_ssh_root.join("ssh_connections.json"))
                .unwrap()
                .unwrap();
        assert_eq!(connections[0].id, "ssh-user@example.invalid");
        assert!(report
            .requires_reauthentication
            .contains(&"ssh-user@example.invalid".to_string()));
        assert!(!roots
            .target_ssh_root
            .join("ssh_password_vault.json")
            .exists());
    }

    #[test]
    fn canonical_remote_fixture_is_read_by_current_owners_after_migration() {
        let temp = test_tempdir("canonical-fixture");
        let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../services/legacy-migration/tests/fixtures/v0.2.19");
        let roots = MigrationRoots {
            legacy_user_root: fixture.join("user-root"),
            legacy_home_root: fixture.join("home"),
            legacy_skills_root: fixture.join("user-root/skills"),
            legacy_ssh_root: fixture.join("ssh"),
            target_user_root: temp.path().join("target/user"),
            target_home_root: temp.path().join("target/home"),
            target_skills_root: temp.path().join("target/skills"),
            target_ssh_root: temp.path().join("target/ssh"),
        };
        let report = run_remote_group(&roots);
        assert!(matches!(
            report.status,
            MigrationRunStatus::Completed | MigrationRunStatus::CompletedWithWarnings
        ));
        let identity =
            owner::read_device_identity(&roots.target_home_root.join("device_identity.json"))
                .unwrap()
                .unwrap();
        assert_eq!(identity.device_id, "0123456789abcdef0123456789abcdef");
        let bot = owner::read_bot_persistence(
            &roots
                .target_home_root
                .join("remote_connect_persistence.json"),
        )
        .unwrap()
        .unwrap();
        assert!(bot.connections[0].chat_state.account_remote_context);
        let connections =
            owner::read_saved_connections(&roots.target_ssh_root.join("ssh_connections.json"))
                .unwrap()
                .unwrap();
        assert_eq!(connections[0].id, "ssh-fixture@example.invalid");
        let workspaces = owner::read_current_remote_workspaces(
            &roots.target_ssh_root.join("remote_workspace.json"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(workspaces[0].connection_id, connections[0].id);
        assert_eq!(workspaces[0].remote_path, "/srv/fixture-workspace");
        assert_eq!(
            owner::read_known_hosts(&roots.target_ssh_root.join("known_hosts"))
                .unwrap()
                .unwrap()
                .len(),
            1
        );
    }

    fn connection(id: &str) -> SavedConnectionRecord {
        SavedConnectionRecord {
            id: id.to_string(),
            name: "fixture connection".to_string(),
            host: "example.invalid".to_string(),
            port: 22,
            username: "user".to_string(),
            auth_type: SavedAuthTypeRecord::Password,
            default_workspace: Some("/srv/project".to_string()),
            last_connected: Some(1),
            proxy_jump: Some("jump.example.invalid".to_string()),
            container: None,
            options: owner::SshConnectionOptionsRecord::default(),
        }
    }

    fn workspace(connection_id: &str) -> RemoteWorkspaceRecord {
        RemoteWorkspaceRecord {
            connection_id: connection_id.to_string(),
            remote_path: "/srv/project".to_string(),
            connection_name: "fixture connection".to_string(),
            ssh_host: "example.invalid".to_string(),
        }
    }

    fn known_host(fingerprint: &str, public_key: &str) -> KnownHostRecord {
        KnownHostRecord {
            host: "example.invalid".to_string(),
            port: 22,
            key_type: "ssh-ed25519".to_string(),
            fingerprint: fingerprint.to_string(),
            public_key: public_key.to_string(),
        }
    }

    fn run_remote_group(
        roots: &MigrationRoots,
    ) -> openbitfun_product_domains::legacy_migration::MigrationRunReport {
        let source = probe_legacy_source(roots, ProbeLimits::default())
            .unwrap()
            .expect("legacy source");
        let selection = MigrationSelection {
            groups: BTreeSet::from([MigrationGroupId::RemoteConnectionsAndDevices]),
        };
        let engine = MigrationEngine::new(roots.clone(), adapters_for_groups(&selection)).unwrap();
        let plan = engine
            .plan(&source, selection, &CancellationToken::default())
            .unwrap();
        engine
            .execute(&plan, &CancellationToken::default(), &NoCrashInjection)
            .unwrap()
    }

    fn seed_probe_source(roots: &MigrationRoots) {
        let path = roots.legacy_user_root.join("config/app.json");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, r#"{"version":"0.2.19"}"#).unwrap();
    }

    fn fixture_roots(root: &Path) -> MigrationRoots {
        MigrationRoots {
            legacy_user_root: root.join("legacy/user"),
            legacy_home_root: root.join("legacy/home"),
            legacy_skills_root: root.join("legacy/skills"),
            legacy_ssh_root: root.join("legacy/ssh"),
            target_user_root: root.join("target/user"),
            target_home_root: root.join("target/home"),
            target_skills_root: root.join("target/skills"),
            target_ssh_root: root.join("target/ssh"),
        }
    }

    fn source_hashes(root: &Path) -> BTreeMap<String, String> {
        FILES
            .into_iter()
            .filter_map(|relative| {
                let path = root.join(relative);
                path.exists()
                    .then(|| (relative.to_string(), file_digest(&path).unwrap()))
            })
            .collect()
    }

    fn assert_stage_redacted(roots: &MigrationRoots, run_id: &str, secret: &str) {
        let stage = roots
            .migration_root()
            .join("runs")
            .join(run_id)
            .join("stage/remote-ssh");
        for entry in fs::read_dir(stage).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert!(!fs::read_to_string(path).unwrap().contains(secret));
            }
        }
    }

    fn test_tempdir(label: &str) -> tempfile::TempDir {
        let root = std::env::var_os("OPENBITFUN_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix(&format!("remote-ssh-migration-{label}-"))
            .tempdir_in(root)
            .unwrap()
    }
}
