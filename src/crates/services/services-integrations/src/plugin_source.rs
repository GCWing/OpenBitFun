//! OpenBitFun-managed plugin package discovery and trust persistence.
//!
//! This module reads only OpenBitFun-managed package roots. Ecosystem-specific
//! file interpretation remains in the corresponding adapter.

use fs2::FileExt;
use openbitfun_product_domains::plugin_source::{
    PluginActivationAuthority, PluginPackageInput, PluginPackageManifest,
    PluginPackageSourceIdentity, PluginPackageTrustLevel, PluginSourceContractError,
    PluginTrustStore, PLUGIN_TRUST_STORE_SCHEMA_VERSION,
};
pub use openbitfun_product_domains::plugin_source::{
    PluginPackageTrustLevel as ManagedPluginTrustLevel,
    PluginTrustDecision as ManagedPluginTrustDecision,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::ffi::OsStr;
use std::fs::OpenOptions;
use std::io::{self, ErrorKind, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::fs;
use tokio::task;

const PLUGIN_MANIFEST_FILE: &str = "openbitfun.plugin.json";
const MAX_MANIFEST_BYTES: u64 = 64 * 1024;
const MAX_PACKAGE_FILE_BYTES: u64 = 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PACKAGES_PER_ROOT: usize = 256;
const MAX_OPERATION_READ_BYTES: u64 = 256 * 1024 * 1024;
const MAX_OPERATION_SCAN_DURATION: Duration = Duration::from_secs(30);
const MAX_TRUST_STORE_BYTES: u64 = 1024 * 1024;
static TRUST_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedPluginPackageView {
    pub package_id: String,
    pub version: String,
    pub adapter: String,
    pub source_scope: String,
    pub source_path: String,
    pub content_hash: String,
    pub trust_level: PluginPackageTrustLevel,
    pub activated: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedPluginSourceIssue {
    pub code: String,
    pub source_path: String,
    pub message: String,
    pub is_error: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedPluginSourceSnapshot {
    pub packages: Vec<ManagedPluginPackageView>,
    pub issues: Vec<ManagedPluginSourceIssue>,
    pub discovery_complete: bool,
    pub trust_epoch: Option<u64>,
    pub activation_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ManagedPluginSourceError {
    #[error("managed plugin package not found: {0}")]
    PackageNotFound(String),
    #[error("managed plugin package {package_id} is invalid: {diagnostic}")]
    PackageInvalid {
        package_id: String,
        diagnostic: String,
    },
    #[error("managed plugin package {package_id} is temporarily unavailable: {diagnostic}")]
    TemporarilyUnavailable {
        package_id: String,
        diagnostic: String,
    },
    #[error(
        "managed plugin package {package_id} deactivation persistence is uncertain: {diagnostic}"
    )]
    DeactivationPersistenceUncertain {
        package_id: String,
        diagnostic: String,
    },
    #[error("managed plugin trust update failed: {0}")]
    TrustStore(String),
}

impl From<PluginSourceStoreError> for ManagedPluginSourceError {
    fn from(error: PluginSourceStoreError) -> Self {
        match error {
            PluginSourceStoreError::PackageNotFound(package_id) => {
                Self::PackageNotFound(package_id)
            }
            PluginSourceStoreError::PackageInvalid {
                package_id,
                diagnostic,
            } => Self::PackageInvalid {
                package_id,
                diagnostic,
            },
            error => Self::TrustStore(error.to_string()),
        }
    }
}

fn map_load_store_error(
    package_id: &str,
    error: PluginSourceStoreError,
) -> ManagedPluginSourceError {
    if matches!(
        error,
        PluginSourceStoreError::TrustGenerationChanged | PluginSourceStoreError::SourceChanged
    ) || trust_store_issue_code(&error) == "trust_store_unavailable"
    {
        ManagedPluginSourceError::TemporarilyUnavailable {
            package_id: package_id.to_string(),
            diagnostic: format!("{error}; retry the operation"),
        }
    } else {
        error.into()
    }
}

fn map_activation_store_error(
    package_id: &str,
    error: PluginSourceStoreError,
) -> ManagedPluginSourceError {
    match error {
        PluginSourceStoreError::Contract(
            error @ (PluginSourceContractError::ActivationRequiresSourceApproval
            | PluginSourceContractError::PluginPackageNotActivated),
        ) => ManagedPluginSourceError::PackageInvalid {
            package_id: package_id.to_string(),
            diagnostic: error.to_string(),
        },
        PluginSourceStoreError::ActivationContentMismatch => {
            ManagedPluginSourceError::PackageInvalid {
                package_id: package_id.to_string(),
                diagnostic: "activation confirmation does not match the current package content"
                    .to_string(),
            }
        }
        PluginSourceStoreError::Contract(error) => {
            ManagedPluginSourceError::TrustStore(error.to_string())
        }
        error => error.into(),
    }
}

fn map_deactivation_store_error(
    package_id: &str,
    error: PluginSourceStoreError,
) -> ManagedPluginSourceError {
    match error {
        error @ (PluginSourceStoreError::TrustDurabilityUncertain { .. }
        | PluginSourceStoreError::TrustCommitUnconfirmed { .. }) => {
            ManagedPluginSourceError::DeactivationPersistenceUncertain {
                package_id: package_id.to_string(),
                diagnostic: error.to_string(),
            }
        }
        error => map_activation_store_error(package_id, error),
    }
}

pub struct ManagedPluginSourceService {
    store: ProductPluginSourceStore,
    load_gate: tokio::sync::Semaphore,
}

impl ManagedPluginSourceService {
    pub fn new(
        user_root: PathBuf,
        user_containment_root: PathBuf,
        workspace_root: PathBuf,
        workspace_containment_root: PathBuf,
        trust_path: PathBuf,
    ) -> Self {
        Self {
            store: ProductPluginSourceStore::new(
                vec![
                    PluginPackageRoot::new(user_root, PluginPackageScope::User)
                        .with_containment_root(user_containment_root),
                    PluginPackageRoot::new(workspace_root, PluginPackageScope::Workspace)
                        .with_containment_root(workspace_containment_root),
                ],
                trust_path,
            ),
            load_gate: tokio::sync::Semaphore::new(1),
        }
    }

    /// Refresh package roots and reconcile stale trust without enabling execution.
    pub async fn refresh(&self, workspace: &Path) -> ManagedPluginSourceSnapshot {
        let scope = workspace_scope(workspace);
        let (discovery, trust_result) = self
            .store
            .reconcile_trust(&scope.project_domain_id, &scope.workspace_id)
            .await;
        let (trust_store, trust_issue) = match trust_result {
            Ok(trust_store) => (Some(trust_store), None),
            Err(error) => (
                None,
                Some(ManagedPluginSourceIssue {
                    code: trust_store_issue_code(&error).to_string(),
                    source_path: self.store.trust_path.to_string_lossy().to_string(),
                    message: error.to_string(),
                    is_error: true,
                }),
            ),
        };
        build_snapshot(discovery, trust_store, trust_issue, &scope)
    }

    /// Apply a trust decision to one package from a complete, stable discovery.
    pub async fn set_trust(
        &self,
        workspace: &Path,
        package_id: &str,
        decision: ManagedPluginTrustDecision,
    ) -> Result<ManagedPluginSourceSnapshot, ManagedPluginSourceError> {
        let scope = workspace_scope(workspace);
        let result = self
            .store
            .apply_trust_decision(
                &scope.project_domain_id,
                &scope.workspace_id,
                package_id,
                decision,
                current_time_ms(),
            )
            .await;
        let (discovery, trust_store) = match result {
            Ok(result) => result,
            Err(error) => return Err(error.into()),
        };
        Ok(build_snapshot(discovery, Some(trust_store), None, &scope))
    }

    /// Activate one exact managed package without changing source approval.
    pub async fn activate(
        &self,
        workspace: &Path,
        package_id: &str,
        expected_content_hash: Option<&str>,
    ) -> Result<(ManagedPluginSourceSnapshot, bool), ManagedPluginSourceError> {
        let scope = workspace_scope(workspace);
        let result = self
            .store
            .activate(
                &scope.project_domain_id,
                &scope.workspace_id,
                package_id,
                expected_content_hash,
                current_time_ms(),
            )
            .await;
        match result {
            Ok(outcome) => {
                let mut snapshot =
                    build_snapshot(outcome.discovery, Some(outcome.trust_store), None, &scope);
                if let Some(error) = outcome.durability_warning {
                    snapshot.issues.push(ManagedPluginSourceIssue {
                        code: "activation_durability_uncertain".to_string(),
                        source_path: self.store.trust_path.display().to_string(),
                        message: error.to_string(),
                        is_error: false,
                    });
                }
                Ok((snapshot, outcome.changed))
            }
            Err(error) => Err(map_activation_store_error(package_id, error)),
        }
    }

    /// Deactivate persisted state before inspecting current package availability.
    pub async fn deactivate(
        &self,
        workspace: &Path,
        package_id: &str,
        expected_activation_epoch: Option<u64>,
    ) -> Result<(ManagedPluginSourceSnapshot, bool, Option<bool>), ManagedPluginSourceError> {
        let scope = workspace_scope(workspace);
        let (cleared_source, had_trust_store, activation_epoch_mismatch) = self
            .store
            .clear_activation_record(
                &scope.project_domain_id,
                &scope.workspace_id,
                package_id,
                expected_activation_epoch,
            )
            .await
            .map_err(|error| map_deactivation_store_error(package_id, error))?;
        if activation_epoch_mismatch {
            return Err(ManagedPluginSourceError::TemporarilyUnavailable {
                package_id: package_id.to_string(),
                diagnostic:
                    "activation state changed while deactivation was being reconciled; retry the operation"
                        .to_string(),
            });
        }
        let (discovery, trust_store, trust_issue) = if had_trust_store {
            let (discovery, trust_result) = self
                .store
                .reconcile_trust(&scope.project_domain_id, &scope.workspace_id)
                .await;
            match trust_result {
                Ok(trust_store) => (discovery, Some(trust_store), None),
                Err(error) => {
                    if matches!(
                        &error,
                        PluginSourceStoreError::TrustDurabilityUncertain { .. }
                            | PluginSourceStoreError::TrustCommitUnconfirmed { .. }
                    ) {
                        return Err(map_deactivation_store_error(package_id, error));
                    }
                    if expected_activation_epoch.is_some() && cleared_source.is_none() {
                        return Err(map_load_store_error(package_id, error));
                    }
                    let issue = ManagedPluginSourceIssue {
                        code: trust_store_issue_code(&error).to_string(),
                        source_path: self.store.trust_path.to_string_lossy().to_string(),
                        message: error.to_string(),
                        is_error: true,
                    };
                    (discovery, None, Some(issue))
                }
            }
        } else {
            let mut scan_budget = OperationScanBudget::new();
            (
                self.store.discover_with_budget(&mut scan_budget).await,
                None,
                None,
            )
        };
        let discovery_complete = discovery.is_complete();
        let cleared_source_available = cleared_source.as_ref().and_then(|cleared_source| {
            discovery_complete.then(|| {
                discovery
                    .packages
                    .iter()
                    .any(|package| package.identity == *cleared_source)
            })
        });
        let snapshot = build_snapshot(discovery, trust_store, trust_issue, &scope);
        if snapshot_has_activation(&snapshot, package_id) {
            return Err(ManagedPluginSourceError::TemporarilyUnavailable {
                package_id: package_id.to_string(),
                diagnostic:
                    "activation state changed while deactivation was being reconciled; retry the operation"
                        .to_string(),
            });
        }
        Ok((snapshot, cleared_source.is_some(), cleared_source_available))
    }

    /// Load one selected package as fixed content for an ecosystem adapter.
    pub async fn load_package(
        &self,
        workspace: &Path,
        package_id: &str,
    ) -> Result<PluginPackageInput, ManagedPluginSourceError> {
        Ok(self.load_approved_package(workspace, package_id).await?.0)
    }

    /// Load fixed package content with evidence for the current activation generation.
    pub async fn load_activated_package(
        &self,
        workspace: &Path,
        package_id: &str,
    ) -> Result<(PluginPackageInput, PluginActivationAuthority), ManagedPluginSourceError> {
        let (input, trust_store, budget) =
            self.load_approved_package(workspace, package_id).await?;
        let (manifest, source, files) = input.into_parts();
        let scope = workspace_scope(workspace);
        let authority = trust_store
            .activation_authority(&scope.project_domain_id, &scope.workspace_id, &source)
            .map_err(|error| ManagedPluginSourceError::PackageInvalid {
                package_id: package_id.to_string(),
                diagnostic: error.to_string(),
            })?;
        if !self
            .store
            .activation_authority_matches(&authority, &budget)
            .await?
        {
            return Err(ManagedPluginSourceError::TemporarilyUnavailable {
                package_id: package_id.to_string(),
                diagnostic: "managed plugin activation changed while loading; retry the operation"
                    .to_string(),
            });
        }
        let input = PluginPackageInput::new(manifest, source, files).map_err(|error| {
            ManagedPluginSourceError::PackageInvalid {
                package_id: package_id.to_string(),
                diagnostic: error.to_string(),
            }
        })?;
        Ok((input, authority))
    }

    /// Check the selected package identity and its persisted activation generation.
    pub async fn has_activation_authority(
        &self,
        workspace: &Path,
        package_id: &str,
        authority: &PluginActivationAuthority,
    ) -> Result<bool, ManagedPluginSourceError> {
        let (input, budget) = match self.read_selected_package(package_id).await {
            Ok(loaded) => loaded,
            Err(
                ManagedPluginSourceError::PackageNotFound(_)
                | ManagedPluginSourceError::PackageInvalid { .. },
            ) => return Ok(false),
            Err(error) => return Err(error),
        };
        let source = input.into_parts().1;
        let (project_domain_id, workspace_id, authority_source, _) = authority.clone().into_parts();
        let scope = workspace_scope(workspace);
        if project_domain_id != scope.project_domain_id
            || workspace_id != scope.workspace_id
            || authority_source != source
        {
            return Ok(false);
        }
        self.store
            .activation_authority_matches(authority, &budget)
            .await
            .map_err(|error| map_load_store_error(package_id, error))
    }

    async fn load_approved_package(
        &self,
        workspace: &Path,
        package_id: &str,
    ) -> Result<(PluginPackageInput, PluginTrustStore, OperationScanBudget), ManagedPluginSourceError>
    {
        let (input, budget) = self.read_selected_package(package_id).await?;
        let input_source = input.clone().into_parts().1;
        let scope = workspace_scope(workspace);
        let trust_store = self
            .store
            .load_trust_store_with_budget(&budget)
            .await
            .map_err(|error| map_load_store_error(package_id, error))?;
        if trust_store.trust_level_for(&scope.project_domain_id, &scope.workspace_id, &input_source)
            != PluginPackageTrustLevel::SourceApproved
        {
            return Err(ManagedPluginSourceError::PackageInvalid {
                package_id: package_id.to_string(),
                diagnostic: "managed plugin package source is not approved".to_string(),
            });
        }
        if !self
            .store
            .trust_approval_matches(
                trust_store.epoch(),
                &scope.project_domain_id,
                &scope.workspace_id,
                &input_source,
                &budget,
            )
            .await
            .map_err(|error| map_load_store_error(package_id, error))?
        {
            return Err(ManagedPluginSourceError::TemporarilyUnavailable {
                package_id: package_id.to_string(),
                diagnostic: "managed plugin trust changed while loading; retry the operation"
                    .to_string(),
            });
        }
        Ok((input, trust_store, budget))
    }

    async fn read_selected_package(
        &self,
        package_id: &str,
    ) -> Result<(PluginPackageInput, OperationScanBudget), ManagedPluginSourceError> {
        let mut budget = OperationScanBudget::new();
        let _load_permit = tokio::time::timeout(budget.remaining_time(), self.load_gate.acquire())
            .await
            .map_err(|_| ManagedPluginSourceError::TemporarilyUnavailable {
                package_id: package_id.to_string(),
                diagnostic: "load capacity is busy; retry the operation".to_string(),
            })?
            .map_err(|_| ManagedPluginSourceError::TemporarilyUnavailable {
                package_id: package_id.to_string(),
                diagnostic: "load capacity is unavailable; retry the operation".to_string(),
            })?;
        let mut discovery = self
            .store
            .discover_with_budget_for(&mut budget, Some(package_id))
            .await;
        if !discovery.is_complete() {
            let issue = discovery
                .issues
                .iter()
                .find(|issue| issue.package_id.as_deref() == Some(package_id))
                .or_else(|| discovery.issues.iter().find(|issue| issue.code.is_error()));
            let diagnostic = issue.map_or_else(
                || "managed plugin discovery is incomplete".to_string(),
                |issue| format!("{}: {}", issue.code.as_str(), issue.message),
            );
            return Err(
                if issue.is_some_and(|issue| {
                    matches!(
                        issue.code,
                        PluginSourceIssueCode::RootReadFailed
                            | PluginSourceIssueCode::ScanBudgetExceeded
                            | PluginSourceIssueCode::FileReadFailed
                    )
                }) {
                    ManagedPluginSourceError::TemporarilyUnavailable {
                        package_id: package_id.to_string(),
                        diagnostic,
                    }
                } else {
                    ManagedPluginSourceError::PackageInvalid {
                        package_id: package_id.to_string(),
                        diagnostic,
                    }
                },
            );
        }
        let index = discovery
            .packages
            .iter()
            .position(|package| package.identity.package_id == package_id)
            .ok_or_else(|| {
                discovery
                    .issues
                    .iter()
                    .find(|issue| {
                        issue.package_id.as_deref() == Some(package_id) && issue.code.is_error()
                    })
                    .map_or_else(
                        || ManagedPluginSourceError::PackageNotFound(package_id.to_string()),
                        |issue| ManagedPluginSourceError::PackageInvalid {
                            package_id: package_id.to_string(),
                            diagnostic: format!("{}: {}", issue.code.as_str(), issue.message),
                        },
                    )
            })?;
        let package = discovery.packages.swap_remove(index);
        let input = PluginPackageInput::new(
            package.manifest,
            package.identity,
            package
                .declared_files
                .expect("selected package discovery must retain declared files"),
        )
        .map_err(|error| ManagedPluginSourceError::PackageInvalid {
            package_id: package_id.to_string(),
            diagnostic: error.to_string(),
        })?;
        Ok((input, budget))
    }
}

fn build_snapshot(
    discovery: PluginSourceDiscovery,
    trust_store: Option<PluginTrustStore>,
    trust_issue: Option<ManagedPluginSourceIssue>,
    scope: &PluginTrustScope,
) -> ManagedPluginSourceSnapshot {
    let discovery_complete = discovery.is_complete();
    let activation_sources = trust_store.as_ref().map_or_else(Vec::new, |trust_store| {
        trust_store.activation_sources(&scope.project_domain_id, &scope.workspace_id)
    });
    let available_sources = discovery
        .packages
        .iter()
        .map(|package| package.identity.clone())
        .collect::<HashSet<_>>();
    let mut issues = discovery
        .issues
        .into_iter()
        .map(PluginSourceIssue::into_view)
        .collect::<Vec<_>>();
    if let Some(issue) = trust_issue {
        issues.push(issue);
    }
    let mut packages = discovery
        .packages
        .into_iter()
        .map(|package| ManagedPluginPackageView {
            package_id: package.identity.package_id.clone(),
            version: package.identity.version.clone(),
            adapter: package.identity.adapter.clone(),
            source_scope: package.source_scope.as_str().to_string(),
            source_path: package.display_path.to_string_lossy().to_string(),
            content_hash: package.identity.content_hash.clone(),
            trust_level: if discovery_complete {
                trust_store
                    .as_ref()
                    .map_or(PluginPackageTrustLevel::Unknown, |trust_store| {
                        trust_store.trust_level_for(
                            &scope.project_domain_id,
                            &scope.workspace_id,
                            &package.identity,
                        )
                    })
            } else {
                PluginPackageTrustLevel::Unknown
            },
            activated: discovery_complete
                && trust_store.as_ref().is_some_and(|trust_store| {
                    trust_store.is_activated(
                        &scope.project_domain_id,
                        &scope.workspace_id,
                        &package.identity,
                    )
                }),
        })
        .collect::<Vec<_>>();
    if discovery_complete {
        for source in activation_sources {
            if !available_sources.contains(&source) {
                let package_id = source.package_id;
                issues.push(ManagedPluginSourceIssue {
                    code: PluginSourceIssueCode::ActivationSourceUnavailable
                        .as_str()
                        .to_string(),
                    source_path: package_id.clone(),
                    message: format!(
                        "saved activation state exists for {package_id}, but its package source is unavailable"
                    ),
                    is_error: false,
                });
            }
        }
    }
    packages.sort_by(|left, right| left.package_id.cmp(&right.package_id));
    issues.sort_by(|left, right| {
        left.source_path
            .cmp(&right.source_path)
            .then_with(|| left.code.cmp(&right.code))
    });

    ManagedPluginSourceSnapshot {
        packages,
        issues,
        discovery_complete,
        trust_epoch: trust_store.as_ref().map(PluginTrustStore::epoch),
        activation_epoch: trust_store.as_ref().map(PluginTrustStore::activation_epoch),
    }
}

fn snapshot_has_activation(snapshot: &ManagedPluginSourceSnapshot, package_id: &str) -> bool {
    snapshot
        .packages
        .iter()
        .any(|package| package.package_id == package_id && package.activated)
        || snapshot.issues.iter().any(|issue| {
            issue.code == PluginSourceIssueCode::ActivationSourceUnavailable.as_str()
                && issue.source_path == package_id
        })
}

fn trust_store_issue_code(error: &PluginSourceStoreError) -> &'static str {
    match error {
        PluginSourceStoreError::Contract(_) | PluginSourceStoreError::TrustDeserialize { .. } => {
            "trust_store_invalid"
        }
        PluginSourceStoreError::TrustRead { source, .. }
            if matches!(
                source.kind(),
                ErrorKind::InvalidData | ErrorKind::FileTooLarge
            ) =>
        {
            "trust_store_invalid"
        }
        _ => "trust_store_unavailable",
    }
}

fn current_time_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

struct PluginTrustScope {
    project_domain_id: String,
    workspace_id: String,
}

fn workspace_scope(workspace: &Path) -> PluginTrustScope {
    let canonical = dunce::canonicalize(workspace).unwrap_or_else(|_| workspace.to_path_buf());
    let digest = native_path_digest(&canonical);
    PluginTrustScope {
        project_domain_id: format!("project:local:{digest}"),
        workspace_id: format!("workspace:local:{digest}"),
    }
}

fn native_path_identity(path: &Path) -> String {
    format!(
        "path:{}:sha256:{}",
        native_path_platform(),
        native_path_digest(path)
    )
}

#[cfg(unix)]
fn native_path_digest(path: &Path) -> String {
    use std::os::unix::ffi::OsStrExt;

    hex::encode(Sha256::digest(path.as_os_str().as_bytes()))
}

#[cfg(windows)]
fn native_path_digest(path: &Path) -> String {
    use std::os::windows::ffi::OsStrExt;

    let mut hasher = Sha256::new();
    for unit in path.as_os_str().encode_wide() {
        hasher.update(unit.to_le_bytes());
    }
    hex::encode(hasher.finalize())
}

#[cfg(not(any(unix, windows)))]
fn native_path_digest(path: &Path) -> String {
    hex::encode(Sha256::digest(path.to_string_lossy().as_bytes()))
}

#[cfg(unix)]
const fn native_path_platform() -> &'static str {
    "unix"
}

#[cfg(windows)]
const fn native_path_platform() -> &'static str {
    "windows"
}

#[cfg(not(any(unix, windows)))]
const fn native_path_platform() -> &'static str {
    "other"
}

#[derive(Debug, Clone)]
struct PluginPackageRoot {
    path: PathBuf,
    containment_root: PathBuf,
    source_scope: PluginPackageScope,
}

impl PluginPackageRoot {
    fn new(path: PathBuf, source_scope: PluginPackageScope) -> Self {
        let containment_root = path
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| path.clone());
        Self {
            path,
            containment_root,
            source_scope,
        }
    }

    fn with_containment_root(mut self, containment_root: PathBuf) -> Self {
        self.containment_root = containment_root;
        self
    }
}

struct SecureManagedRoot {
    path: PathBuf,
    #[cfg(unix)]
    handle: std::fs::File,
    #[cfg(windows)]
    canonical_path: Vec<u16>,
    #[cfg(windows)]
    _handle: std::fs::File,
}

struct SecurePackageDirectory {
    // Retained for Windows / fallback open paths; Unix reads via directory fd.
    #[cfg_attr(unix, allow(dead_code))]
    path: PathBuf,
    #[cfg(unix)]
    handle: std::fs::File,
    #[cfg(windows)]
    canonical_path: Vec<u16>,
    #[cfg(windows)]
    _handle: std::fs::File,
}

impl SecureManagedRoot {
    fn open(root: &PluginPackageRoot) -> io::Result<Self> {
        #[cfg(unix)]
        {
            let relative = root
                .path
                .strip_prefix(&root.containment_root)
                .map_err(|_| {
                    io::Error::new(
                        ErrorKind::InvalidInput,
                        "plugin root is outside its containment root",
                    )
                })?;
            let handle = open_directory_chain(&root.containment_root, relative)?;
            Ok(Self {
                path: root.path.clone(),
                handle,
            })
        }
        #[cfg(windows)]
        {
            let containment = open_windows_directory(&root.containment_root)?;
            let containment_path = windows_handle_path(&containment)?;
            let handle = open_windows_directory(&root.path)?;
            let canonical_path = windows_handle_path(&handle)?;
            if !windows_path_is_within(&canonical_path, &containment_path) {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "plugin root handle resolves outside its containment root",
                ));
            }
            Ok(Self {
                path: root.path.clone(),
                canonical_path,
                _handle: handle,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(Self {
                path: root.path.clone(),
            })
        }
    }

    fn open_package(&self, name: &OsStr) -> io::Result<SecurePackageDirectory> {
        let path = self.path.join(name);
        #[cfg(unix)]
        {
            Ok(SecurePackageDirectory {
                path,
                handle: openat_directory(&self.handle, name)?,
            })
        }
        #[cfg(windows)]
        {
            let handle = open_windows_directory(&path)?;
            let canonical_path = windows_handle_path(&handle)?;
            if !windows_path_is_within(&canonical_path, &self.canonical_path) {
                return Err(io::Error::new(
                    ErrorKind::PermissionDenied,
                    "plugin package handle resolves outside its managed root",
                ));
            }
            Ok(SecurePackageDirectory {
                path,
                canonical_path,
                _handle: handle,
            })
        }
        #[cfg(not(any(unix, windows)))]
        {
            Ok(SecurePackageDirectory { path })
        }
    }

    fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            path: self.path.clone(),
            #[cfg(unix)]
            handle: self.handle.try_clone()?,
            #[cfg(windows)]
            canonical_path: self.canonical_path.clone(),
            #[cfg(windows)]
            _handle: self._handle.try_clone()?,
        })
    }
}

impl SecurePackageDirectory {
    async fn read_bounded(
        &self,
        relative_path: &Path,
        max_bytes: u64,
    ) -> Result<Vec<u8>, MeteredReadError> {
        let relative_path = relative_path.to_path_buf();
        #[cfg(unix)]
        let directory = self.handle.try_clone().map_err(MeteredReadError::unread)?;
        #[cfg(windows)]
        let (path, canonical_root) = (self.path.clone(), self.canonical_path.clone());
        #[cfg(not(any(unix, windows)))]
        let path = self.path.clone();
        task::spawn_blocking(move || {
            #[cfg(unix)]
            let file = openat_regular_file(&directory, &relative_path)
                .map_err(MeteredReadError::unread)?;
            #[cfg(windows)]
            let file = open_windows_package_file(&path, &canonical_root, &relative_path)
                .map_err(MeteredReadError::unread)?;
            #[cfg(not(any(unix, windows)))]
            let file = open_regular_file_no_follow(&path.join(&relative_path))
                .map_err(MeteredReadError::unread)?;
            read_bounded_file_metered(file, max_bytes)
        })
        .await
        .map_err(|error| MeteredReadError::unread(io::Error::other(error.to_string())))?
    }
}

#[derive(Debug)]
struct MeteredReadError {
    source: io::Error,
    observed_bytes: u64,
}

impl MeteredReadError {
    fn unread(source: io::Error) -> Self {
        Self {
            source,
            observed_bytes: 0,
        }
    }
}

enum ScannedFileReadError {
    BudgetExceeded,
    Io(io::Error),
}

async fn read_scanned_file(
    package: &SecurePackageDirectory,
    relative_path: &Path,
    file_limit: u64,
    scan_budget: &mut OperationScanBudget,
) -> Result<Vec<u8>, ScannedFileReadError> {
    let remaining = scan_budget.remaining();
    if remaining == 0 {
        return Err(ScannedFileReadError::BudgetExceeded);
    }
    let read_limit = file_limit.min(remaining);
    charge_scanned_read(
        package.read_bounded(relative_path, read_limit).await,
        read_limit,
        file_limit,
        scan_budget,
    )
}

fn charge_scanned_read(
    result: Result<Vec<u8>, MeteredReadError>,
    read_limit: u64,
    file_limit: u64,
    scan_budget: &mut OperationScanBudget,
) -> Result<Vec<u8>, ScannedFileReadError> {
    match result {
        Ok(bytes) => {
            if scan_budget.consume(bytes.len() as u64) {
                Ok(bytes)
            } else {
                Err(ScannedFileReadError::BudgetExceeded)
            }
        }
        Err(error) => {
            let within_budget = scan_budget.consume(error.observed_bytes);
            if (error.source.kind() == ErrorKind::FileTooLarge && read_limit < file_limit)
                || !within_budget
            {
                Err(ScannedFileReadError::BudgetExceeded)
            } else {
                Err(ScannedFileReadError::Io(error.source))
            }
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PluginPackageScope {
    User,
    Workspace,
}

impl PluginPackageScope {
    const fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Workspace => "workspace",
        }
    }
}

#[derive(Debug, Clone)]
struct DiscoveredPluginPackage {
    identity: PluginPackageSourceIdentity,
    manifest: PluginPackageManifest,
    declared_files: Option<BTreeMap<String, Vec<u8>>>,
    source_scope: PluginPackageScope,
    display_path: PathBuf,
}

struct OperationScanBudget {
    limit: u64,
    observed_bytes: u64,
    deadline: Instant,
}

impl OperationScanBudget {
    fn new() -> Self {
        Self {
            limit: MAX_OPERATION_READ_BYTES,
            observed_bytes: 0,
            deadline: Instant::now() + MAX_OPERATION_SCAN_DURATION,
        }
    }

    #[cfg(test)]
    fn with_limits(limit: u64, duration: Duration) -> Self {
        Self {
            limit,
            observed_bytes: 0,
            deadline: Instant::now() + duration,
        }
    }

    fn remaining(&self) -> u64 {
        self.limit.saturating_sub(self.observed_bytes)
    }

    fn consume(&mut self, bytes: u64) -> bool {
        let Some(total) = self.observed_bytes.checked_add(bytes) else {
            self.observed_bytes = self.limit;
            return false;
        };
        if total > self.limit {
            self.observed_bytes = self.limit;
            return false;
        }
        self.observed_bytes = total;
        true
    }

    fn remaining_time(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
}

#[derive(Debug, Default)]
struct PluginSourceDiscovery {
    packages: Vec<DiscoveredPluginPackage>,
    issues: Vec<PluginSourceIssue>,
    workspace_package_ids: HashSet<String>,
}

impl PluginSourceDiscovery {
    fn identities(&self) -> Vec<PluginPackageSourceIdentity> {
        self.packages
            .iter()
            .map(|package| package.identity.clone())
            .collect()
    }

    fn is_complete(&self) -> bool {
        !self.issues.iter().any(|issue| {
            matches!(
                issue.code,
                PluginSourceIssueCode::RootReadFailed
                    | PluginSourceIssueCode::EntryLimitExceeded
                    | PluginSourceIssueCode::ScanBudgetExceeded
                    | PluginSourceIssueCode::FileReadFailed
            )
        })
    }

    fn apply_workspace_precedence(&mut self) {
        let mut retained_packages = Vec::with_capacity(self.packages.len());
        let mut shadowed = Vec::new();
        let mut shadowed_ids = HashSet::new();
        for package in self.packages.drain(..) {
            if package.source_scope == PluginPackageScope::User
                && self
                    .workspace_package_ids
                    .contains(&package.identity.package_id)
            {
                if shadowed_ids.insert(package.identity.package_id.clone()) {
                    shadowed.push((
                        package.identity.package_id.clone(),
                        package.display_path.clone(),
                    ));
                }
            } else {
                retained_packages.push(package);
            }
        }
        let mut retained_issues = Vec::with_capacity(self.issues.len());
        for issue in self.issues.drain(..) {
            let is_shadowed = issue.source_scope == Some(PluginPackageScope::User)
                && issue
                    .package_id
                    .as_ref()
                    .is_some_and(|id| self.workspace_package_ids.contains(id));
            if is_shadowed {
                if let Some(package_id) = issue.package_id.as_ref() {
                    if shadowed_ids.insert(package_id.clone()) {
                        shadowed.push((package_id.clone(), issue.source_path.clone()));
                    }
                }
            } else {
                retained_issues.push(issue);
            }
        }
        for (package_id, source_path) in shadowed {
            retained_issues.push(PluginSourceIssue::new(
                PluginSourceIssueCode::ShadowedPackage,
                source_path,
                format!("user plugin package {package_id} is shadowed by the workspace package"),
            ));
        }
        self.packages = retained_packages;
        self.issues = retained_issues;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PluginSourceIssueCode {
    RootReadFailed,
    EntryLimitExceeded,
    ScanBudgetExceeded,
    MissingManifest,
    InvalidManifest,
    PackageIdMismatch,
    SymlinkNotAllowed,
    InvalidPackageFile,
    FileTooLarge,
    FileReadFailed,
    HashMismatch,
    ShadowedPackage,
    ActivationSourceUnavailable,
}

impl PluginSourceIssueCode {
    const fn as_str(self) -> &'static str {
        match self {
            Self::RootReadFailed => "root_read_failed",
            Self::EntryLimitExceeded => "entry_limit_exceeded",
            Self::ScanBudgetExceeded => "scan_budget_exceeded",
            Self::MissingManifest => "missing_manifest",
            Self::InvalidManifest => "invalid_manifest",
            Self::PackageIdMismatch => "package_id_mismatch",
            Self::SymlinkNotAllowed => "symlink_not_allowed",
            Self::InvalidPackageFile => "invalid_package_file",
            Self::FileTooLarge => "file_too_large",
            Self::FileReadFailed => "file_read_failed",
            Self::HashMismatch => "hash_mismatch",
            Self::ShadowedPackage => "shadowed_package",
            Self::ActivationSourceUnavailable => "activation_source_unavailable",
        }
    }

    const fn is_error(self) -> bool {
        !matches!(
            self,
            Self::ShadowedPackage | Self::ActivationSourceUnavailable
        )
    }
}

#[derive(Debug, Clone)]
struct PluginSourceIssue {
    code: PluginSourceIssueCode,
    source_path: PathBuf,
    message: String,
    source_scope: Option<PluginPackageScope>,
    package_id: Option<String>,
}

impl PluginSourceIssue {
    fn new(
        code: PluginSourceIssueCode,
        source_path: impl Into<PathBuf>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            code,
            source_path: source_path.into(),
            message: message.into(),
            source_scope: None,
            package_id: None,
        }
    }

    fn for_package(mut self, source_scope: PluginPackageScope, package_id: Option<&str>) -> Self {
        self.source_scope = Some(source_scope);
        self.package_id = package_id.map(str::to_string);
        self
    }

    fn into_view(self) -> ManagedPluginSourceIssue {
        ManagedPluginSourceIssue {
            code: self.code.as_str().to_string(),
            source_path: self.source_path.to_string_lossy().to_string(),
            message: self.message,
            is_error: self.code.is_error(),
        }
    }
}

fn operation_scan_timeout(path: &Path) -> PluginSourceIssue {
    PluginSourceIssue::new(
        PluginSourceIssueCode::ScanBudgetExceeded,
        path,
        "managed plugin operation exceeded the 30 second scan budget",
    )
}

struct ProductPluginSourceStore {
    roots: Vec<PluginPackageRoot>,
    trust_path: PathBuf,
    parent_sync: fn(&Path) -> io::Result<()>,
}

struct LoadedTrustStore {
    store: PluginTrustStore,
    identity: Option<TrustFileIdentity>,
}

struct ActivationStoreOutcome {
    discovery: PluginSourceDiscovery,
    trust_store: PluginTrustStore,
    changed: bool,
    durability_warning: Option<PluginSourceStoreError>,
}

#[derive(Debug)]
struct TrustFileGuard {
    file: Option<std::fs::File>,
}

#[derive(Debug, Clone, Copy)]
enum TrustFileExpectation {
    Missing,
    Identity(TrustFileIdentity),
}

impl TrustFileGuard {
    async fn run_blocking<T: Send + 'static>(
        &mut self,
        operation: impl FnOnce() -> Result<T, PluginSourceStoreError> + Send + 'static,
    ) -> Result<T, PluginSourceStoreError> {
        let file = self.file.take().ok_or_else(|| {
            PluginSourceStoreError::TrustTransactionTask("lock guard missing".into())
        })?;
        let (file, result) = task::spawn_blocking(move || {
            let result = operation();
            (file, result)
        })
        .await
        .map_err(|error| PluginSourceStoreError::TrustTransactionTask(error.to_string()))?;
        self.file = Some(file);
        result
    }
}

#[cfg(unix)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrustFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrustFileIdentity {
    volume_serial: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(not(any(unix, windows)))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct TrustFileIdentity {
    len: u64,
    modified: Option<SystemTime>,
}

impl ProductPluginSourceStore {
    fn new(roots: Vec<PluginPackageRoot>, trust_path: PathBuf) -> Self {
        Self {
            roots,
            trust_path,
            parent_sync: sync_parent_directory,
        }
    }

    #[cfg(test)]
    async fn discover(&self) -> PluginSourceDiscovery {
        let mut budget = OperationScanBudget::new();
        self.discover_with_budget(&mut budget).await
    }

    async fn discover_with_budget(
        &self,
        budget: &mut OperationScanBudget,
    ) -> PluginSourceDiscovery {
        self.discover_with_budget_for(budget, None).await
    }

    async fn discover_with_budget_for(
        &self,
        budget: &mut OperationScanBudget,
        retained_package_id: Option<&str>,
    ) -> PluginSourceDiscovery {
        let mut discovery = PluginSourceDiscovery::default();
        for root in &self.roots {
            let remaining = budget.remaining_time();
            if remaining.is_zero() {
                discovery.issues.push(operation_scan_timeout(&root.path));
                break;
            }
            if tokio::time::timeout(
                remaining,
                self.discover_root(root, &mut discovery, budget, retained_package_id),
            )
            .await
            .is_err()
            {
                discovery.issues.push(operation_scan_timeout(&root.path));
                break;
            }
        }
        discovery.apply_workspace_precedence();
        discovery
            .packages
            .sort_by(|left, right| left.display_path.cmp(&right.display_path));
        discovery
    }

    async fn discover_root(
        &self,
        root: &PluginPackageRoot,
        discovery: &mut PluginSourceDiscovery,
        scan_budget: &mut OperationScanBudget,
        retained_package_id: Option<&str>,
    ) {
        let root_metadata = match fs::symlink_metadata(&root.path).await {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == ErrorKind::NotFound => return,
            Err(error) => {
                discovery.issues.push(PluginSourceIssue::new(
                    PluginSourceIssueCode::RootReadFailed,
                    &root.path,
                    format!("failed to inspect managed plugin root: {error}"),
                ));
                return;
            }
        };
        if is_unsupported_link(&root_metadata) || !root_metadata.is_dir() {
            discovery.issues.push(PluginSourceIssue::new(
                PluginSourceIssueCode::RootReadFailed,
                &root.path,
                "managed plugin root must be a regular directory without links",
            ));
            return;
        }
        if let Err(error) = validate_managed_root_chain(&root.containment_root, &root.path).await {
            discovery.issues.push(PluginSourceIssue::new(
                PluginSourceIssueCode::RootReadFailed,
                &root.path,
                format!("managed plugin root crosses an invalid path boundary: {error}"),
            ));
            return;
        }
        let root_path = root.path.clone();
        let containment_path = root.containment_root.clone();
        let (canonical_root, canonical_containment) = match task::spawn_blocking(move || {
            Ok::<_, io::Error>((
                dunce::canonicalize(root_path)?,
                dunce::canonicalize(containment_path)?,
            ))
        })
        .await
        {
            Ok(Ok(paths)) => paths,
            Ok(Err(error)) => {
                discovery.issues.push(PluginSourceIssue::new(
                    PluginSourceIssueCode::RootReadFailed,
                    &root.path,
                    format!("failed to resolve managed plugin root boundary: {error}"),
                ));
                return;
            }
            Err(error) => {
                discovery.issues.push(PluginSourceIssue::new(
                    PluginSourceIssueCode::RootReadFailed,
                    &root.path,
                    format!("managed plugin root resolution task failed: {error}"),
                ));
                return;
            }
        };
        if !canonical_root.starts_with(&canonical_containment) {
            discovery.issues.push(PluginSourceIssue::new(
                PluginSourceIssueCode::RootReadFailed,
                &root.path,
                "managed plugin root resolves outside its containment root",
            ));
            return;
        }
        let root_config = root.clone();
        let secure_root =
            match task::spawn_blocking(move || SecureManagedRoot::open(&root_config)).await {
                Ok(Ok(root)) => root,
                Ok(Err(error)) => {
                    discovery.issues.push(PluginSourceIssue::new(
                        PluginSourceIssueCode::RootReadFailed,
                        &root.path,
                        format!("failed to open managed plugin root securely: {error}"),
                    ));
                    return;
                }
                Err(error) => {
                    discovery.issues.push(PluginSourceIssue::new(
                        PluginSourceIssueCode::RootReadFailed,
                        &root.path,
                        format!("managed plugin root open task failed: {error}"),
                    ));
                    return;
                }
            };
        let mut entries = match fs::read_dir(&root.path).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == ErrorKind::NotFound => return,
            Err(error) => {
                discovery.issues.push(PluginSourceIssue::new(
                    PluginSourceIssueCode::RootReadFailed,
                    &root.path,
                    format!("failed to read managed plugin root: {error}"),
                ));
                return;
            }
        };

        let mut package_paths = Vec::new();
        loop {
            match entries.next_entry().await {
                Ok(Some(entry)) if package_paths.len() < MAX_PACKAGES_PER_ROOT => {
                    package_paths.push(entry.path());
                }
                Ok(Some(_)) => {
                    discovery.issues.push(PluginSourceIssue::new(
                        PluginSourceIssueCode::EntryLimitExceeded,
                        &root.path,
                        format!(
                            "managed plugin root exceeds the {MAX_PACKAGES_PER_ROOT} entry limit"
                        ),
                    ));
                    break;
                }
                Ok(None) => break,
                Err(error) => {
                    discovery.issues.push(PluginSourceIssue::new(
                        PluginSourceIssueCode::RootReadFailed,
                        &root.path,
                        format!("failed to enumerate managed plugin root: {error}"),
                    ));
                    break;
                }
            }
        }
        package_paths.sort();

        for package_path in package_paths {
            if scan_budget.remaining_time().is_zero() {
                discovery.issues.push(operation_scan_timeout(&root.path));
                break;
            }
            let package_id = package_path.file_name().and_then(|name| name.to_str());
            if root.source_scope == PluginPackageScope::Workspace {
                if let Some(package_id) = package_id {
                    discovery
                        .workspace_package_ids
                        .insert(package_id.to_string());
                }
            }
            if retained_package_id.is_some_and(|target| package_id != Some(target)) {
                continue;
            }
            let metadata = match fs::symlink_metadata(&package_path).await {
                Ok(metadata) => metadata,
                Err(error) => {
                    discovery.issues.push(
                        PluginSourceIssue::new(
                            PluginSourceIssueCode::FileReadFailed,
                            &package_path,
                            format!("failed to inspect package path: {error}"),
                        )
                        .for_package(root.source_scope, package_id),
                    );
                    continue;
                }
            };
            if is_unsupported_link(&metadata) {
                discovery.issues.push(
                    PluginSourceIssue::new(
                        PluginSourceIssueCode::SymlinkNotAllowed,
                        &package_path,
                        "managed plugin package directories cannot be links or reparse points",
                    )
                    .for_package(root.source_scope, package_id),
                );
                continue;
            }
            if !metadata.is_dir() {
                discovery.issues.push(
                    PluginSourceIssue::new(
                        PluginSourceIssueCode::InvalidPackageFile,
                        &package_path,
                        "managed plugin root entries must be package directories",
                    )
                    .for_package(root.source_scope, package_id),
                );
                continue;
            }
            let Some(package_name) = package_path.file_name() else {
                discovery.issues.push(
                    PluginSourceIssue::new(
                        PluginSourceIssueCode::InvalidPackageFile,
                        &package_path,
                        "managed plugin package path has no directory name",
                    )
                    .for_package(root.source_scope, package_id),
                );
                continue;
            };
            let secure_root_for_open = match secure_root.try_clone() {
                Ok(root) => root,
                Err(error) => {
                    discovery.issues.push(
                        PluginSourceIssue::new(
                            PluginSourceIssueCode::FileReadFailed,
                            &package_path,
                            format!("failed to clone managed root handle: {error}"),
                        )
                        .for_package(root.source_scope, package_id),
                    );
                    continue;
                }
            };
            let package_name = package_name.to_os_string();
            let secure_package = match task::spawn_blocking(move || {
                secure_root_for_open.open_package(&package_name)
            })
            .await
            {
                Ok(Ok(package)) => package,
                Ok(Err(error)) => {
                    discovery.issues.push(
                        PluginSourceIssue::new(
                            PluginSourceIssueCode::FileReadFailed,
                            &package_path,
                            format!("failed to open package directory securely: {error}"),
                        )
                        .for_package(root.source_scope, package_id),
                    );
                    continue;
                }
                Err(error) => {
                    discovery.issues.push(
                        PluginSourceIssue::new(
                            PluginSourceIssueCode::FileReadFailed,
                            &package_path,
                            format!("managed plugin package open task failed: {error}"),
                        )
                        .for_package(root.source_scope, package_id),
                    );
                    continue;
                }
            };
            match discover_package(
                &package_path,
                &canonical_root,
                root.source_scope,
                &secure_package,
                scan_budget,
                package_id == retained_package_id,
            )
            .await
            {
                Ok(package) => discovery.packages.push(package),
                Err(issue) => {
                    let budget_exceeded = issue.code == PluginSourceIssueCode::ScanBudgetExceeded;
                    discovery
                        .issues
                        .push(issue.for_package(root.source_scope, package_id));
                    if budget_exceeded {
                        break;
                    }
                }
            }
        }
    }

    async fn load_trust_store_locked(
        &self,
        file_guard: &mut TrustFileGuard,
    ) -> Result<PluginTrustStore, PluginSourceStoreError> {
        Ok(self
            .load_trust_store_generation_locked(file_guard, true)
            .await?
            .store)
    }

    async fn load_trust_store_generation_locked(
        &self,
        file_guard: &mut TrustFileGuard,
        persist_missing: bool,
    ) -> Result<LoadedTrustStore, PluginSourceStoreError> {
        let (bytes, identity) = match read_trust_file(&self.trust_path).await {
            Ok(loaded) => loaded,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                let store = PluginTrustStore::new(fresh_trust_epoch());
                if !persist_missing {
                    return Ok(LoadedTrustStore {
                        store,
                        identity: None,
                    });
                }
                self.persist_trust_store_locked(&store, file_guard, TrustFileExpectation::Missing)
                    .await?;
                read_trust_file(&self.trust_path).await.map_err(|source| {
                    PluginSourceStoreError::TrustRead {
                        path: self.trust_path.clone(),
                        source,
                    }
                })?
            }
            Err(source) => {
                return Err(PluginSourceStoreError::TrustRead {
                    path: self.trust_path.clone(),
                    source,
                });
            }
        };
        let persisted = serde_json::from_slice::<serde_json::Value>(&bytes).map_err(|source| {
            PluginSourceStoreError::TrustDeserialize {
                path: self.trust_path.clone(),
                source,
            }
        })?;
        if let Some(schema_version) = persisted
            .get("schemaVersion")
            .and_then(serde_json::Value::as_u64)
            .and_then(|version| u16::try_from(version).ok())
        {
            if schema_version != PLUGIN_TRUST_STORE_SCHEMA_VERSION {
                return Err(
                    PluginSourceContractError::UnsupportedTrustStoreSchema(schema_version).into(),
                );
            }
        }
        let store = serde_json::from_value::<PluginTrustStore>(persisted).map_err(|source| {
            PluginSourceStoreError::TrustDeserialize {
                path: self.trust_path.clone(),
                source,
            }
        })?;
        store.validate()?;
        Ok(LoadedTrustStore {
            store,
            identity: Some(identity),
        })
    }

    async fn trust_generation_matches(
        &self,
        expected: TrustFileIdentity,
    ) -> Result<bool, PluginSourceStoreError> {
        let path = self.trust_path.clone();
        task::spawn_blocking(move || {
            let file = open_regular_file_no_follow(&path)?;
            Ok::<_, io::Error>(trust_file_identity(&file)? == expected)
        })
        .await
        .map_err(|error| PluginSourceStoreError::TrustReadTask(error.to_string()))?
        .or_else(|error| {
            if error.kind() == ErrorKind::NotFound {
                Ok(false)
            } else {
                Err(PluginSourceStoreError::TrustRead {
                    path: self.trust_path.clone(),
                    source: error,
                })
            }
        })
    }

    async fn apply_trust_decision(
        &self,
        project_domain_id: &str,
        workspace_id: &str,
        package_id: &str,
        decision: ManagedPluginTrustDecision,
        updated_at_ms: u64,
    ) -> Result<(PluginSourceDiscovery, PluginTrustStore), PluginSourceStoreError> {
        let mut scan_budget = OperationScanBudget::new();
        let discovery = self.discover_with_budget(&mut scan_budget).await;
        if !discovery.is_complete() {
            return Err(PluginSourceStoreError::IncompleteDiscovery);
        }
        let source = discovery
            .packages
            .iter()
            .find(|package| package.identity.package_id == package_id)
            .map(|package| package.identity.clone())
            .ok_or_else(|| {
                discovery
                    .issues
                    .iter()
                    .find(|issue| {
                        issue.package_id.as_deref() == Some(package_id) && issue.code.is_error()
                    })
                    .map_or_else(
                        || PluginSourceStoreError::PackageNotFound(package_id.to_string()),
                        |issue| PluginSourceStoreError::PackageInvalid {
                            package_id: package_id.to_string(),
                            diagnostic: format!(
                                "{} at {}: {}",
                                issue.code.as_str(),
                                issue.source_path.display(),
                                issue.message
                            ),
                        },
                    )
            })?;
        let mut file_guard = self.acquire_trust_file_lock(&scan_budget).await?;
        let loaded = self
            .load_trust_store_generation_locked(&mut file_guard, false)
            .await?;
        let mut store = loaded.store;
        let before = store.clone();
        store.reconcile_sources(project_domain_id, workspace_id, &discovery.identities())?;
        store.apply_decision(
            project_domain_id,
            workspace_id,
            source,
            decision,
            updated_at_ms,
        )?;
        let verified = self.discover_with_budget(&mut scan_budget).await;
        if !verified.is_complete()
            || discovery.identities() != verified.identities()
            || discovery.workspace_package_ids != verified.workspace_package_ids
        {
            return Err(PluginSourceStoreError::SourceChanged);
        }
        if store != before {
            self.persist_trust_store_locked(
                &store,
                &mut file_guard,
                loaded
                    .identity
                    .map(TrustFileExpectation::Identity)
                    .unwrap_or(TrustFileExpectation::Missing),
            )
            .await?;
        }
        Ok((verified, store))
    }

    async fn activate(
        &self,
        project_domain_id: &str,
        workspace_id: &str,
        package_id: &str,
        expected_content_hash: Option<&str>,
        updated_at_ms: u64,
    ) -> Result<ActivationStoreOutcome, PluginSourceStoreError> {
        let mut scan_budget = OperationScanBudget::new();
        let discovery = self.discover_with_budget(&mut scan_budget).await;
        if !discovery.is_complete() {
            return Err(PluginSourceStoreError::IncompleteDiscovery);
        }
        let source = discovery
            .packages
            .iter()
            .find(|package| package.identity.package_id == package_id)
            .map(|package| package.identity.clone())
            .ok_or_else(|| PluginSourceStoreError::PackageNotFound(package_id.to_string()))?;
        if expected_content_hash.is_none_or(|expected| expected != source.content_hash) {
            return Err(PluginSourceStoreError::ActivationContentMismatch);
        }
        let mut file_guard = self.acquire_trust_file_lock(&scan_budget).await?;
        let loaded = self
            .load_trust_store_generation_locked(&mut file_guard, false)
            .await?;
        let mut store = loaded.store;
        let before = store.clone();
        store.reconcile_sources(project_domain_id, workspace_id, &discovery.identities())?;
        let changed = store.activate(project_domain_id, workspace_id, source, updated_at_ms)?;
        let verified = self.discover_with_budget(&mut scan_budget).await;
        if !verified.is_complete()
            || discovery.identities() != verified.identities()
            || discovery.workspace_package_ids != verified.workspace_package_ids
        {
            return Err(PluginSourceStoreError::SourceChanged);
        }
        let durability_warning = if store != before {
            match self
                .persist_trust_store_locked(
                    &store,
                    &mut file_guard,
                    loaded
                        .identity
                        .map(TrustFileExpectation::Identity)
                        .unwrap_or(TrustFileExpectation::Missing),
                )
                .await
            {
                Ok(()) => None,
                Err(error @ PluginSourceStoreError::TrustDurabilityUncertain { .. }) => Some(error),
                Err(error) => return Err(error),
            }
        } else {
            None
        };
        Ok(ActivationStoreOutcome {
            discovery: verified,
            trust_store: store,
            changed,
            durability_warning,
        })
    }

    async fn clear_activation_record(
        &self,
        project_domain_id: &str,
        workspace_id: &str,
        package_id: &str,
        expected_activation_epoch: Option<u64>,
    ) -> Result<(Option<PluginPackageSourceIdentity>, bool, bool), PluginSourceStoreError> {
        let budget = OperationScanBudget::new();
        let mut file_guard = self.acquire_trust_file_lock(&budget).await?;
        let loaded = self
            .load_trust_store_generation_locked(&mut file_guard, false)
            .await?;
        let had_trust_store = loaded.identity.is_some();
        let mut store = loaded.store;
        let had_activation = store
            .activation_sources(project_domain_id, workspace_id)
            .iter()
            .any(|source| source.package_id == package_id);
        let cleared_source = store.clear_activation_record(
            project_domain_id,
            workspace_id,
            package_id,
            expected_activation_epoch,
        )?;
        if cleared_source.is_none() {
            if had_trust_store {
                self.sync_trust_parent_locked(&mut file_guard).await?;
            }
            return Ok((
                None,
                had_trust_store,
                expected_activation_epoch.is_some() && had_activation,
            ));
        }
        self.persist_trust_store_locked(
            &store,
            &mut file_guard,
            loaded
                .identity
                .map(TrustFileExpectation::Identity)
                .unwrap_or(TrustFileExpectation::Missing),
        )
        .await?;
        Ok((cleared_source, had_trust_store, false))
    }

    async fn reconcile_trust(
        &self,
        project_domain_id: &str,
        workspace_id: &str,
    ) -> (
        PluginSourceDiscovery,
        Result<PluginTrustStore, PluginSourceStoreError>,
    ) {
        let mut scan_budget = OperationScanBudget::new();
        self.reconcile_trust_with_budget(project_domain_id, workspace_id, &mut scan_budget)
            .await
    }

    async fn reconcile_trust_with_budget(
        &self,
        project_domain_id: &str,
        workspace_id: &str,
        scan_budget: &mut OperationScanBudget,
    ) -> (
        PluginSourceDiscovery,
        Result<PluginTrustStore, PluginSourceStoreError>,
    ) {
        let discovery = self.discover_with_budget(scan_budget).await;
        let mut file_guard = match self.acquire_trust_file_lock(scan_budget).await {
            Ok(guard) => guard,
            Err(error) => return (discovery, Err(error)),
        };
        let loaded = match self
            .load_trust_store_generation_locked(&mut file_guard, true)
            .await
        {
            Ok(store) => store,
            Err(error) => return (discovery, Err(error)),
        };
        let loaded_identity = loaded
            .identity
            .expect("persist_missing=true must return a persisted trust generation");
        let store = loaded.store;
        if !discovery.is_complete() {
            if !matches!(
                self.trust_generation_matches(loaded_identity).await,
                Ok(true)
            ) {
                return (
                    discovery,
                    self.load_trust_store_locked(&mut file_guard).await,
                );
            }
            return (discovery, Ok(store));
        }
        let mut next = store.clone();
        let changed = match next.reconcile_sources(
            project_domain_id,
            workspace_id,
            &discovery.identities(),
        ) {
            Ok(changed) => changed,
            Err(error) => return (discovery, Err(error.into())),
        };
        if !changed {
            if !matches!(
                self.trust_generation_matches(loaded_identity).await,
                Ok(true)
            ) {
                return (
                    discovery,
                    self.load_trust_store_locked(&mut file_guard).await,
                );
            }
            return (discovery, Ok(store));
        }
        let verified = self.discover_with_budget(scan_budget).await;
        if !verified.is_complete()
            || discovery.identities() != verified.identities()
            || discovery.workspace_package_ids != verified.workspace_package_ids
        {
            return (verified, Ok(store));
        }
        match self.trust_generation_matches(loaded_identity).await {
            Ok(true) => {}
            Ok(false) => {
                return (
                    verified,
                    Err(PluginSourceStoreError::TrustGenerationChanged),
                )
            }
            Err(error) => return (verified, Err(error)),
        }
        if let Err(error) = self
            .persist_trust_store_locked(
                &next,
                &mut file_guard,
                TrustFileExpectation::Identity(loaded_identity),
            )
            .await
        {
            return (verified, Err(error));
        }
        (verified, Ok(next))
    }

    async fn trust_approval_matches(
        &self,
        expected_epoch: u64,
        project_domain_id: &str,
        workspace_id: &str,
        source: &PluginPackageSourceIdentity,
        operation_budget: &OperationScanBudget,
    ) -> Result<bool, PluginSourceStoreError> {
        let mut file_guard = self.acquire_trust_file_lock(operation_budget).await?;
        let current = self.load_trust_store_locked(&mut file_guard).await?;
        Ok(current.epoch() == expected_epoch
            && current.trust_level_for(project_domain_id, workspace_id, source)
                == PluginPackageTrustLevel::SourceApproved)
    }

    async fn activation_authority_matches(
        &self,
        authority: &PluginActivationAuthority,
        operation_budget: &OperationScanBudget,
    ) -> Result<bool, PluginSourceStoreError> {
        let mut file_guard = self.acquire_trust_file_lock(operation_budget).await?;
        let current = self.load_trust_store_locked(&mut file_guard).await?;
        Ok(current.is_activation_current(authority))
    }

    async fn load_trust_store_with_budget(
        &self,
        operation_budget: &OperationScanBudget,
    ) -> Result<PluginTrustStore, PluginSourceStoreError> {
        let mut file_guard = self.acquire_trust_file_lock(operation_budget).await?;
        self.load_trust_store_locked(&mut file_guard).await
    }

    async fn acquire_trust_file_lock(
        &self,
        operation_budget: &OperationScanBudget,
    ) -> Result<TrustFileGuard, PluginSourceStoreError> {
        let lock_path = self.trust_path.with_extension("lock");
        let parent = lock_path
            .parent()
            .ok_or(PluginSourceStoreError::InvalidTrustPath)?;
        fs::create_dir_all(parent)
            .await
            .map_err(PluginSourceStoreError::TrustLockIo)?;
        let remaining = operation_budget.remaining_time();
        if remaining.is_zero() {
            return Err(PluginSourceStoreError::TrustLockTimeout);
        }
        let open_task = task::spawn_blocking(move || -> io::Result<std::fs::File> {
            let mut options = OpenOptions::new();
            options.create(true).truncate(false).read(true).write(true);
            configure_no_follow(&mut options);
            let file = options.open(lock_path)?;
            let metadata = file.metadata()?;
            if is_unsupported_link(&metadata) || !metadata.is_file() {
                return Err(io::Error::new(
                    ErrorKind::InvalidData,
                    "plugin trust lock path is not a regular file",
                ));
            }
            Ok(file)
        });
        let file = tokio::time::timeout(remaining, open_task)
            .await
            .map_err(|_| PluginSourceStoreError::TrustLockTimeout)?
            .map_err(|error| PluginSourceStoreError::TrustLockTask(error.to_string()))?
            .map_err(PluginSourceStoreError::TrustLockIo)?;
        loop {
            if operation_budget.remaining_time().is_zero() {
                return Err(PluginSourceStoreError::TrustLockTimeout);
            }
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => {
                    if operation_budget.remaining_time().is_zero() {
                        let _ = FileExt::unlock(&file);
                        return Err(PluginSourceStoreError::TrustLockTimeout);
                    }
                    return Ok(TrustFileGuard { file: Some(file) });
                }
                Err(error)
                    if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() =>
                {
                    let remaining = operation_budget.remaining_time();
                    if remaining.is_zero() {
                        return Err(PluginSourceStoreError::TrustLockTimeout);
                    }
                    tokio::time::sleep(remaining.min(Duration::from_millis(25))).await;
                }
                Err(error) => return Err(PluginSourceStoreError::TrustLockIo(error)),
            }
        }
    }

    async fn persist_trust_store_locked(
        &self,
        store: &PluginTrustStore,
        file_guard: &mut TrustFileGuard,
        expected: TrustFileExpectation,
    ) -> Result<(), PluginSourceStoreError> {
        store.validate()?;
        let bytes = serde_json::to_vec_pretty(store)
            .map_err(|error| PluginSourceStoreError::TrustSerialize(error.to_string()))?;
        if bytes.len() as u64 > MAX_TRUST_STORE_BYTES {
            return Err(PluginSourceStoreError::TrustStoreTooLarge(bytes.len()));
        }
        let trust_path = self.trust_path.clone();
        let parent_sync = self.parent_sync;
        file_guard
            .run_blocking(move || {
                if !trust_file_expectation_matches(&trust_path, expected)? {
                    return Err(PluginSourceStoreError::TrustGenerationChanged);
                }
                persist_trust_bytes_with_parent_sync(&trust_path, &bytes, parent_sync)
            })
            .await
    }

    async fn sync_trust_parent_locked(
        &self,
        file_guard: &mut TrustFileGuard,
    ) -> Result<(), PluginSourceStoreError> {
        let trust_path = self.trust_path.clone();
        let parent = trust_path
            .parent()
            .map(Path::to_path_buf)
            .ok_or(PluginSourceStoreError::InvalidTrustPath)?;
        let parent_sync = self.parent_sync;
        file_guard
            .run_blocking(move || {
                parent_sync(&parent).map_err(|source| {
                    PluginSourceStoreError::TrustDurabilityUncertain {
                        path: trust_path,
                        source,
                    }
                })
            })
            .await
    }

    #[cfg(test)]
    async fn load_trust_store(&self) -> Result<PluginTrustStore, PluginSourceStoreError> {
        let budget = OperationScanBudget::new();
        let mut file_guard = self.acquire_trust_file_lock(&budget).await?;
        self.load_trust_store_locked(&mut file_guard).await
    }

    #[cfg(test)]
    async fn load_trust_store_generation(
        &self,
    ) -> Result<LoadedTrustStore, PluginSourceStoreError> {
        let budget = OperationScanBudget::new();
        let mut file_guard = self.acquire_trust_file_lock(&budget).await?;
        self.load_trust_store_generation_locked(&mut file_guard, true)
            .await
    }

    #[cfg(test)]
    async fn persist_trust_store(
        &self,
        store: &PluginTrustStore,
    ) -> Result<(), PluginSourceStoreError> {
        let budget = OperationScanBudget::new();
        let mut file_guard = self.acquire_trust_file_lock(&budget).await?;
        let expected = current_trust_file_expectation(&self.trust_path)?;
        self.persist_trust_store_locked(store, &mut file_guard, expected)
            .await
    }
}

#[derive(Debug, thiserror::Error)]
enum PluginSourceStoreError {
    #[error(transparent)]
    Contract(#[from] PluginSourceContractError),
    #[error("failed to read plugin trust store {path}: {source}")]
    TrustRead {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("plugin trust read task failed: {0}")]
    TrustReadTask(String),
    #[error("failed to deserialize plugin trust store {path}: {source}")]
    TrustDeserialize {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("plugin trust path has no parent directory")]
    InvalidTrustPath,
    #[error("failed to lock plugin trust store: {0}")]
    TrustLockIo(#[source] io::Error),
    #[error("plugin trust lock task failed: {0}")]
    TrustLockTask(String),
    #[error("timed out waiting for the plugin trust store lock; retry the operation")]
    TrustLockTimeout,
    #[error("plugin trust transaction task failed: {0}")]
    TrustTransactionTask(String),
    #[error("failed to serialize plugin trust store: {0}")]
    TrustSerialize(String),
    #[error("plugin trust store serialization is {0} bytes and exceeds the 1 MiB limit")]
    TrustStoreTooLarge(usize),
    #[error("failed to write plugin trust store {path}: {source}")]
    TrustWrite {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error(
        "plugin trust store {path} contains the requested state, but directory synchronization failed; the decision may not survive a system crash: {source}"
    )]
    TrustDurabilityUncertain {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("plugin trust store {path} could not be verified after atomic replacement: {source}")]
    TrustCommitUnconfirmed {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("managed plugin package not found: {0}")]
    PackageNotFound(String),
    #[error("managed plugin package {package_id} is invalid: {diagnostic}")]
    PackageInvalid {
        package_id: String,
        diagnostic: String,
    },
    #[error("managed plugin discovery is incomplete; trust changes are disabled")]
    IncompleteDiscovery,
    #[error("managed plugin sources changed during trust validation; retry the operation")]
    SourceChanged,
    #[error("managed plugin activation confirmation does not match the current content hash")]
    ActivationContentMismatch,
    #[error("plugin trust store generation changed during the operation; retry the operation")]
    TrustGenerationChanged,
}

fn persist_trust_bytes_with_parent_sync(
    path: &Path,
    bytes: &[u8],
    sync_parent: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<(), PluginSourceStoreError> {
    let parent = path
        .parent()
        .ok_or(PluginSourceStoreError::InvalidTrustPath)?;
    std::fs::create_dir_all(parent).map_err(|source| PluginSourceStoreError::TrustWrite {
        path: path.to_path_buf(),
        source,
    })?;
    let counter = TRUST_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("trust.json");
    let temp_path = parent.join(format!(
        ".{file_name}.{}.{}.{}.tmp",
        std::process::id(),
        nonce,
        counter
    ));
    let replace_result = (|| -> io::Result<()> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        configure_no_follow(&mut options);
        let mut file = options.open(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        drop(file);
        replace_file_atomically(&temp_path, path)?;
        Ok(())
    })();
    if replace_result.is_err() && path.exists() {
        let _ = std::fs::remove_file(&temp_path);
    }
    replace_result.map_err(|source| PluginSourceStoreError::TrustWrite {
        path: path.to_path_buf(),
        source,
    })?;
    let parent_sync_error = sync_parent(parent).err();
    let readback = open_regular_file_no_follow(path).and_then(|file| {
        read_bounded_file_metered(file, MAX_TRUST_STORE_BYTES).map_err(|error| error.source)
    });
    match readback {
        Ok(persisted) if persisted == bytes => match parent_sync_error {
            Some(source) => Err(PluginSourceStoreError::TrustDurabilityUncertain {
                path: path.to_path_buf(),
                source,
            }),
            None => Ok(()),
        },
        Ok(_) => Err(PluginSourceStoreError::TrustCommitUnconfirmed {
            path: path.to_path_buf(),
            source: io::Error::new(
                parent_sync_error
                    .as_ref()
                    .map_or(ErrorKind::InvalidData, io::Error::kind),
                parent_sync_error.map_or_else(
                    || "persisted bytes differ from the requested trust state".to_string(),
                    |error| {
                        format!("{error}; persisted bytes differ from the requested trust state")
                    },
                ),
            ),
        }),
        Err(read_error) => Err(PluginSourceStoreError::TrustCommitUnconfirmed {
            path: path.to_path_buf(),
            source: io::Error::new(
                read_error.kind(),
                parent_sync_error.map_or_else(
                    || format!("failed to read the replaced trust store: {read_error}"),
                    |error| {
                        format!("{error}; failed to read the replaced trust store: {read_error}")
                    },
                ),
            ),
        }),
    }
}

#[cfg(windows)]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, ReplaceFileW, MOVEFILE_WRITE_THROUGH, REPLACEFILE_WRITE_THROUGH,
    };

    let temp = temp_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let target = target_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let backup_path = temp_path.with_extension("backup");
    let backup = backup_path
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        if target_path.exists() {
            ReplaceFileW(
                PCWSTR(target.as_ptr()),
                PCWSTR(temp.as_ptr()),
                PCWSTR(backup.as_ptr()),
                REPLACEFILE_WRITE_THROUGH,
                None,
                None,
            )
        } else {
            MoveFileExW(
                PCWSTR(temp.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_WRITE_THROUGH,
            )
        }
    };
    match result {
        Ok(()) => {
            let _ = std::fs::remove_file(backup_path);
            Ok(())
        }
        Err(replace_error) => restore_windows_backup_after_replace_failure(
            &backup_path,
            target_path,
            io::Error::other(replace_error.to_string()),
        ),
    }
}

#[cfg(windows)]
fn restore_windows_backup_after_replace_failure(
    backup_path: &Path,
    target_path: &Path,
    replace_error: io::Error,
) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    if backup_path.exists() {
        let backup = backup_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let target = target_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let restore = unsafe {
            MoveFileExW(
                PCWSTR(backup.as_ptr()),
                PCWSTR(target.as_ptr()),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if let Err(restore_error) = restore {
            return Err(io::Error::other(format!(
                "atomic replace failed ({replace_error}); backup restore failed ({restore_error})"
            )));
        }
    }
    Err(replace_error)
}

#[cfg(not(windows))]
fn replace_file_atomically(temp_path: &Path, target_path: &Path) -> io::Result<()> {
    std::fs::rename(temp_path, target_path)
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> io::Result<()> {
    std::fs::File::open(parent)?.sync_all()
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path) -> io::Result<()> {
    Ok(())
}

async fn read_trust_file(path: &Path) -> io::Result<(Vec<u8>, TrustFileIdentity)> {
    let path = path.to_path_buf();
    task::spawn_blocking(move || {
        let file = open_regular_file_no_follow(&path)?;
        let identity = trust_file_identity(&file)?;
        let bytes =
            read_bounded_file_metered(file, MAX_TRUST_STORE_BYTES).map_err(|error| error.source)?;
        Ok((bytes, identity))
    })
    .await
    .map_err(|error| io::Error::other(error.to_string()))?
}

#[cfg(unix)]
fn trust_file_identity(file: &std::fs::File) -> io::Result<TrustFileIdentity> {
    use std::os::unix::fs::MetadataExt;

    let metadata = file.metadata()?;
    Ok(TrustFileIdentity {
        device: metadata.dev(),
        inode: metadata.ino(),
    })
}

#[cfg(test)]
fn current_trust_file_expectation(
    path: &Path,
) -> Result<TrustFileExpectation, PluginSourceStoreError> {
    match open_regular_file_no_follow(path) {
        Ok(file) => Ok(TrustFileExpectation::Identity(
            trust_file_identity(&file).map_err(|source| PluginSourceStoreError::TrustRead {
                path: path.to_path_buf(),
                source,
            })?,
        )),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(TrustFileExpectation::Missing),
        Err(source) => Err(PluginSourceStoreError::TrustRead {
            path: path.to_path_buf(),
            source,
        }),
    }
}

fn trust_file_expectation_matches(
    path: &Path,
    expected: TrustFileExpectation,
) -> Result<bool, PluginSourceStoreError> {
    match (expected, open_regular_file_no_follow(path)) {
        (TrustFileExpectation::Missing, Err(error)) if error.kind() == ErrorKind::NotFound => {
            Ok(true)
        }
        (TrustFileExpectation::Missing, Ok(_)) => Ok(false),
        (TrustFileExpectation::Identity(expected), Ok(file)) => Ok(trust_file_identity(&file)
            .map_err(|source| PluginSourceStoreError::TrustRead {
                path: path.to_path_buf(),
                source,
            })?
            == expected),
        (TrustFileExpectation::Identity(_), Err(error)) if error.kind() == ErrorKind::NotFound => {
            Ok(false)
        }
        (_, Err(source)) => Err(PluginSourceStoreError::TrustRead {
            path: path.to_path_buf(),
            source,
        }),
    }
}

#[cfg(windows)]
fn trust_file_identity(file: &std::fs::File) -> io::Result<TrustFileIdentity> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
    };

    let mut information = BY_HANDLE_FILE_INFORMATION::default();
    unsafe {
        GetFileInformationByHandle(HANDLE(file.as_raw_handle()), &mut information)
            .map_err(|error| io::Error::other(error.to_string()))?;
    }
    Ok(TrustFileIdentity {
        volume_serial: information.dwVolumeSerialNumber,
        file_index_high: information.nFileIndexHigh,
        file_index_low: information.nFileIndexLow,
    })
}

#[cfg(not(any(unix, windows)))]
fn trust_file_identity(file: &std::fs::File) -> io::Result<TrustFileIdentity> {
    let metadata = file.metadata()?;
    Ok(TrustFileIdentity {
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn open_regular_file_no_follow(path: &Path) -> io::Result<std::fs::File> {
    let mut options = OpenOptions::new();
    options.read(true);
    configure_no_follow(&mut options);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if is_unsupported_link(&metadata) || !metadata.is_file() {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "opened path is not a regular file or is a link",
        ));
    }
    Ok(file)
}

fn read_bounded_file_metered(
    file: std::fs::File,
    max_bytes: u64,
) -> Result<Vec<u8>, MeteredReadError> {
    let capacity = file
        .metadata()
        .map_err(MeteredReadError::unread)?
        .len()
        .min(max_bytes) as usize;
    read_bounded_reader(file, max_bytes, capacity)
}

fn read_bounded_reader(
    mut reader: impl Read,
    max_bytes: u64,
    capacity: usize,
) -> Result<Vec<u8>, MeteredReadError> {
    let mut bytes = Vec::with_capacity(capacity);
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let detection_limit = max_bytes.saturating_add(1);
        let remaining = detection_limit.saturating_sub(bytes.len() as u64) as usize;
        let read_capacity = remaining.min(buffer.len());
        match reader.read(&mut buffer[..read_capacity]) {
            Ok(0) => return Ok(bytes),
            Ok(read) => {
                bytes.extend_from_slice(&buffer[..read]);
                if bytes.len() as u64 > max_bytes {
                    return Err(MeteredReadError {
                        source: io::Error::new(
                            ErrorKind::FileTooLarge,
                            format!("file exceeds the {max_bytes} byte limit"),
                        ),
                        observed_bytes: bytes.len() as u64,
                    });
                }
            }
            Err(source) => {
                return Err(MeteredReadError {
                    source,
                    observed_bytes: bytes.len() as u64,
                });
            }
        }
    }
}

#[cfg(unix)]
fn open_directory_chain(base: &Path, relative: &Path) -> io::Result<std::fs::File> {
    let mut directory = open_directory_no_follow(base)?;
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                ErrorKind::InvalidInput,
                "managed plugin directory path must contain only normal components",
            ));
        };
        directory = openat_directory(&directory, name)?;
    }
    Ok(directory)
}

#[cfg(unix)]
fn open_directory_no_follow(path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::FromRawFd;

    let path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `path` is a NUL-terminated CString that outlives this call, and
    // the flags are a valid `open` flag set.
    let fd = unsafe {
        libc::open(
            path.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `open` just returned this descriptor and the error case returned
    // above, so it is open, valid, and owned by nothing else.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn openat_directory(directory: &std::fs::File, name: &OsStr) -> io::Result<std::fs::File> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let name = std::ffi::CString::new(name.as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `directory` is a live `File` borrowed for this call, so its
    // descriptor stays open; `name` is a NUL-terminated CString outliving the
    // call, and the flags are a valid `openat` flag set.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `openat` just returned this descriptor and the error case
    // returned above, so it is open, valid, and owned by nothing else.
    Ok(unsafe { std::fs::File::from_raw_fd(fd) })
}

#[cfg(unix)]
fn openat_regular_file(base: &std::fs::File, relative_path: &Path) -> io::Result<std::fs::File> {
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::{AsRawFd, FromRawFd};

    let components = relative_path
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err(io::Error::new(
                ErrorKind::InvalidInput,
                "package file path must contain only normal components",
            )),
        })
        .collect::<io::Result<Vec<_>>>()?;
    let (file_name, parents) = components
        .split_last()
        .ok_or_else(|| io::Error::new(ErrorKind::InvalidInput, "empty package file path"))?;
    let mut directory = base.try_clone()?;
    for parent in parents {
        directory = openat_directory(&directory, parent)?;
    }
    let file_name = std::ffi::CString::new(file_name.as_bytes())
        .map_err(|_| io::Error::new(ErrorKind::InvalidInput, "path contains NUL"))?;
    // SAFETY: `directory` is a live `File` held for this call, so its
    // descriptor stays open; `file_name` is a NUL-terminated CString outliving
    // the call, and the flags are a valid `openat` flag set.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            file_name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `openat` just returned this descriptor and the error case
    // returned above, so it is open, valid, and owned by nothing else.
    let file = unsafe { std::fs::File::from_raw_fd(fd) };
    if !file.metadata()?.is_file() {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "package path is not a regular file",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn open_windows_directory(path: &Path) -> io::Result<std::fs::File> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    let mut options = OpenOptions::new();
    options
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if is_unsupported_link(&metadata) || !metadata.is_dir() {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "opened path is not a regular directory or is a reparse point",
        ));
    }
    Ok(file)
}

#[cfg(windows)]
fn windows_handle_path(file: &std::fs::File) -> io::Result<Vec<u16>> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, VOLUME_NAME_DOS};

    let handle = HANDLE(file.as_raw_handle());
    let mut buffer = vec![0_u16; 512];
    loop {
        let length = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, VOLUME_NAME_DOS) };
        if length == 0 {
            return Err(io::Error::last_os_error());
        }
        if length as usize >= buffer.len() {
            buffer.resize(length as usize + 1, 0);
            continue;
        }
        buffer.truncate(length as usize);
        return Ok(buffer);
    }
}

#[cfg(windows)]
fn windows_path_is_within(path: &[u16], root: &[u16]) -> bool {
    const VERBATIM_PREFIX: &[u16] = &[b'\\' as u16, b'\\' as u16, b'?' as u16, b'\\' as u16];
    let normalize = |value: &[u16]| {
        let value = value.strip_prefix(VERBATIM_PREFIX).unwrap_or(value);
        let mut normalized = value
            .iter()
            .copied()
            .map(|unit| match unit {
                unit if unit == b'/' as u16 => b'\\' as u16,
                unit => unit,
            })
            .collect::<Vec<_>>();
        while normalized.last() == Some(&(b'\\' as u16)) {
            normalized.pop();
        }
        normalized
    };
    let path = normalize(path);
    let root = normalize(root);
    path == root
        || path
            .strip_prefix(root.as_slice())
            .is_some_and(|rest| rest.starts_with(&[b'\\' as u16]))
}

#[cfg(windows)]
fn open_windows_package_file(
    package_path: &Path,
    canonical_root: &[u16],
    relative_path: &Path,
) -> io::Result<std::fs::File> {
    if relative_path
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(io::Error::new(
            ErrorKind::InvalidInput,
            "package file path must contain only normal components",
        ));
    }
    let file = open_regular_file_no_follow(&package_path.join(relative_path))?;
    let final_path = windows_handle_path(&file)?;
    if !windows_path_is_within(&final_path, canonical_root) {
        return Err(io::Error::new(
            ErrorKind::PermissionDenied,
            "package file handle resolves outside the package directory",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn configure_no_follow(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn configure_no_follow(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn configure_no_follow(_options: &mut OpenOptions) {}

async fn validate_managed_root_chain(containment_root: &Path, root: &Path) -> io::Result<()> {
    let relative = root.strip_prefix(containment_root).map_err(|_| {
        io::Error::new(
            ErrorKind::InvalidInput,
            "managed root is not inside its containment root",
        )
    })?;
    let mut current = containment_root.to_path_buf();
    for component in relative.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).await?;
        if is_unsupported_link(&metadata) || !metadata.is_dir() {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                format!("{} is not a regular directory", current.display()),
            ));
        }
    }
    Ok(())
}

fn is_unsupported_link(metadata: &std::fs::Metadata) -> bool {
    metadata.file_type().is_symlink() || is_windows_reparse_point(metadata)
}

#[cfg(windows)]
fn is_windows_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn is_windows_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

async fn discover_package(
    package_path: &Path,
    canonical_root: &Path,
    source_scope: PluginPackageScope,
    secure_package: &SecurePackageDirectory,
    scan_budget: &mut OperationScanBudget,
    retain_declared_files: bool,
) -> Result<DiscoveredPluginPackage, PluginSourceIssue> {
    let manifest_path = package_path.join(PLUGIN_MANIFEST_FILE);
    let metadata = fs::symlink_metadata(&manifest_path)
        .await
        .map_err(|error| {
            let code = if error.kind() == ErrorKind::NotFound {
                PluginSourceIssueCode::MissingManifest
            } else {
                PluginSourceIssueCode::FileReadFailed
            };
            PluginSourceIssue::new(
                code,
                &manifest_path,
                format!("failed to inspect manifest: {error}"),
            )
        })?;
    if is_unsupported_link(&metadata) {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::SymlinkNotAllowed,
            &manifest_path,
            "plugin manifest cannot be a symbolic link",
        ));
    }
    if !metadata.is_file() {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::InvalidManifest,
            &manifest_path,
            "plugin manifest is not a regular file",
        ));
    }
    let manifest_bytes = read_scanned_file(
        secure_package,
        Path::new(PLUGIN_MANIFEST_FILE),
        MAX_MANIFEST_BYTES,
        scan_budget,
    )
    .await
    .map_err(|error| {
        let ScannedFileReadError::Io(error) = error else {
            return PluginSourceIssue::new(
                PluginSourceIssueCode::ScanBudgetExceeded,
                package_path,
                "managed plugin operation exceeded the 256 MiB content-read budget",
            );
        };
        PluginSourceIssue::new(
            if error.kind() == ErrorKind::FileTooLarge {
                PluginSourceIssueCode::FileTooLarge
            } else {
                PluginSourceIssueCode::FileReadFailed
            },
            &manifest_path,
            format!("failed to read plugin manifest: {error}"),
        )
    })?;
    let manifest_json = std::str::from_utf8(&manifest_bytes).map_err(|error| {
        PluginSourceIssue::new(
            PluginSourceIssueCode::InvalidManifest,
            &manifest_path,
            format!("plugin manifest must be UTF-8: {error}"),
        )
    })?;
    let manifest = PluginPackageManifest::parse_json(manifest_json).map_err(|error| {
        PluginSourceIssue::new(
            PluginSourceIssueCode::InvalidManifest,
            &manifest_path,
            error.to_string(),
        )
    })?;
    let directory_name = package_path.file_name().and_then(|name| name.to_str());
    if directory_name != Some(manifest.id.as_str()) {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::PackageIdMismatch,
            package_path,
            "plugin package directory name must match manifest id",
        ));
    }

    let package_path_for_resolution = package_path.to_path_buf();
    let canonical_path =
        task::spawn_blocking(move || dunce::canonicalize(package_path_for_resolution))
            .await
            .map_err(|error| {
                PluginSourceIssue::new(
                    PluginSourceIssueCode::FileReadFailed,
                    package_path,
                    format!("plugin package resolution task failed: {error}"),
                )
            })?
            .map_err(|error| {
                PluginSourceIssue::new(
                    PluginSourceIssueCode::FileReadFailed,
                    package_path,
                    format!("failed to canonicalize plugin package: {error}"),
                )
            })?;
    if !canonical_path.starts_with(canonical_root) {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::SymlinkNotAllowed,
            package_path,
            "plugin package resolves outside its managed root",
        ));
    }

    let mut package_bytes = 0_u64;
    let mut declared_files = BTreeMap::new();
    for file in &manifest.files {
        let bytes = validate_declared_file(
            package_path,
            &canonical_path,
            secure_package,
            &file.path,
            &file.sha256,
            scan_budget,
        )
        .await?;
        package_bytes = package_bytes
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| {
                PluginSourceIssue::new(
                    PluginSourceIssueCode::FileTooLarge,
                    package_path,
                    "plugin package size exceeds the supported limit",
                )
            })?;
        if package_bytes > MAX_PACKAGE_BYTES {
            return Err(PluginSourceIssue::new(
                PluginSourceIssueCode::FileTooLarge,
                package_path,
                "plugin package declared files exceed the 16 MiB limit",
            ));
        }
        if retain_declared_files {
            declared_files.insert(file.path.clone(), bytes);
        }
    }
    let identity = PluginPackageSourceIdentity {
        package_id: manifest.id.clone(),
        version: manifest.version.clone(),
        adapter: manifest.adapter.clone(),
        source_path: native_path_identity(&canonical_path),
        content_hash: manifest
            .content_hash()
            .expect("parsed package manifest must remain valid"),
    };

    Ok(DiscoveredPluginPackage {
        identity,
        manifest,
        declared_files: retain_declared_files.then_some(declared_files),
        source_scope,
        display_path: canonical_path,
    })
}

fn fresh_trust_epoch() -> u64 {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let epoch =
        u64::from_le_bytes(bytes[..8].try_into().expect("UUID prefix length")) & (u64::MAX >> 1);
    epoch.max(1)
}

async fn validate_declared_file(
    package_path: &Path,
    canonical_package_path: &Path,
    secure_package: &SecurePackageDirectory,
    relative_path: &str,
    expected_hash: &str,
    scan_budget: &mut OperationScanBudget,
) -> Result<Vec<u8>, PluginSourceIssue> {
    let relative_path = PathBuf::from(relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
    validate_parent_components(package_path, &relative_path).await?;
    let path = package_path.join(&relative_path);
    let metadata = fs::symlink_metadata(&path).await.map_err(|error| {
        PluginSourceIssue::new(
            PluginSourceIssueCode::FileReadFailed,
            &path,
            format!("failed to inspect declared package file: {error}"),
        )
    })?;
    if is_unsupported_link(&metadata) {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::SymlinkNotAllowed,
            &path,
            "declared package files cannot be symbolic links",
        ));
    }
    if !metadata.is_file() {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::InvalidPackageFile,
            &path,
            "declared package path is not a regular file",
        ));
    }
    let path_for_resolution = path.clone();
    let canonical_path = task::spawn_blocking(move || dunce::canonicalize(path_for_resolution))
        .await
        .map_err(|error| {
            PluginSourceIssue::new(
                PluginSourceIssueCode::FileReadFailed,
                &path,
                format!("declared package file resolution task failed: {error}"),
            )
        })?
        .map_err(|error| {
            PluginSourceIssue::new(
                PluginSourceIssueCode::FileReadFailed,
                &path,
                format!("failed to resolve declared package file: {error}"),
            )
        })?;
    if !canonical_path.starts_with(canonical_package_path) {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::SymlinkNotAllowed,
            &path,
            "declared package file resolves outside the package",
        ));
    }
    let bytes = read_scanned_file(
        secure_package,
        &relative_path,
        MAX_PACKAGE_FILE_BYTES,
        scan_budget,
    )
    .await
    .map_err(|error| {
        let ScannedFileReadError::Io(error) = error else {
            return PluginSourceIssue::new(
                PluginSourceIssueCode::ScanBudgetExceeded,
                &path,
                "managed plugin operation exceeded the 256 MiB content-read budget",
            );
        };
        PluginSourceIssue::new(
            if error.kind() == ErrorKind::FileTooLarge {
                PluginSourceIssueCode::FileTooLarge
            } else {
                PluginSourceIssueCode::FileReadFailed
            },
            &path,
            format!("failed to read declared package file: {error}"),
        )
    })?;
    let actual_hash = format!("sha256:{}", hex::encode(Sha256::digest(&bytes)));
    if actual_hash != expected_hash {
        return Err(PluginSourceIssue::new(
            PluginSourceIssueCode::HashMismatch,
            &path,
            format!("declared hash {expected_hash} does not match {actual_hash}"),
        ));
    }
    Ok(bytes)
}

async fn validate_parent_components(
    package_path: &Path,
    relative_path: &Path,
) -> Result<(), PluginSourceIssue> {
    let Some(parent) = relative_path.parent() else {
        return Ok(());
    };
    let mut current = package_path.to_path_buf();
    for component in parent.components() {
        current.push(component.as_os_str());
        let metadata = fs::symlink_metadata(&current).await.map_err(|error| {
            PluginSourceIssue::new(
                declared_parent_metadata_issue_code(error.kind()),
                &current,
                format!("failed to inspect package directory: {error}"),
            )
        })?;
        if is_unsupported_link(&metadata) {
            return Err(PluginSourceIssue::new(
                PluginSourceIssueCode::SymlinkNotAllowed,
                &current,
                "declared package paths cannot traverse symbolic links",
            ));
        }
        if !metadata.is_dir() {
            return Err(PluginSourceIssue::new(
                PluginSourceIssueCode::InvalidPackageFile,
                &current,
                "declared package path parent is not a directory",
            ));
        }
    }
    Ok(())
}

fn declared_parent_metadata_issue_code(kind: ErrorKind) -> PluginSourceIssueCode {
    if kind == ErrorKind::NotFound {
        PluginSourceIssueCode::InvalidPackageFile
    } else {
        PluginSourceIssueCode::FileReadFailed
    }
}

#[cfg(test)]
mod tests {
    use super::{
        build_snapshot, charge_scanned_read, declared_parent_metadata_issue_code,
        map_activation_store_error, map_load_store_error, native_path_identity,
        persist_trust_bytes_with_parent_sync, read_bounded_reader, read_scanned_file,
        replace_file_atomically, trust_file_identity, trust_store_issue_code, workspace_scope,
        ManagedPluginSourceError, ManagedPluginSourceService, OperationScanBudget,
        PluginPackageManifest, PluginPackageRoot, PluginPackageScope, PluginSourceDiscovery,
        PluginSourceIssue, PluginSourceIssueCode, PluginSourceStoreError, PluginTrustScope,
        ProductPluginSourceStore, ScannedFileReadError, SecureManagedRoot,
        MAX_OPERATION_READ_BYTES, MAX_PACKAGE_FILE_BYTES, MAX_TRUST_STORE_BYTES,
    };
    use openbitfun_product_domains::plugin_source::{
        PluginPackageTrustLevel, PluginSourceContractError, PluginTrustDecision,
    };
    use sha2::{Digest, Sha256};
    use std::io::{self, ErrorKind, Read};
    use std::path::{Path, PathBuf};
    use std::time::{Duration, Instant};

    fn sha256(bytes: &[u8]) -> String {
        format!("sha256:{}", hex::encode(Sha256::digest(bytes)))
    }

    #[test]
    fn operation_content_read_budget_is_bounded() {
        let mut budget =
            OperationScanBudget::with_limits(MAX_OPERATION_READ_BYTES, Duration::from_secs(30));
        assert!(budget.consume(MAX_OPERATION_READ_BYTES));
        assert_eq!(budget.remaining(), 0);
        assert!(!budget.consume(1));

        let mut overflow = OperationScanBudget::with_limits(u64::MAX, Duration::from_secs(30));
        assert!(overflow.consume(u64::MAX));
        assert!(!overflow.consume(1));
    }

    #[test]
    fn transient_package_metadata_failures_make_discovery_incomplete() {
        assert_eq!(
            declared_parent_metadata_issue_code(io::ErrorKind::NotFound),
            PluginSourceIssueCode::InvalidPackageFile
        );
        assert_eq!(
            declared_parent_metadata_issue_code(io::ErrorKind::PermissionDenied),
            PluginSourceIssueCode::FileReadFailed
        );

        let mut discovery = PluginSourceDiscovery::default();
        discovery.issues.push(PluginSourceIssue::new(
            PluginSourceIssueCode::FileReadFailed,
            "package",
            "injected transient open failure",
        ));
        assert!(!discovery.is_complete());
    }

    struct ReadThenError {
        bytes: std::io::Cursor<Vec<u8>>,
    }

    impl Read for ReadThenError {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            if self.bytes.position() < self.bytes.get_ref().len() as u64 {
                return self.bytes.read(buffer);
            }
            Err(io::Error::other("injected read failure"))
        }
    }

    #[test]
    fn partial_read_failure_reports_observed_bytes() {
        let read_result = read_bounded_reader(
            ReadThenError {
                bytes: std::io::Cursor::new(b"read".to_vec()),
            },
            16,
            0,
        );
        let observed = read_result
            .as_ref()
            .expect_err("reader must fail after returning data")
            .observed_bytes;
        let mut budget = OperationScanBudget::with_limits(16, Duration::from_secs(30));
        let charged = charge_scanned_read(read_result, 16, 16, &mut budget);

        assert_eq!(observed, 4);
        assert!(matches!(charged, Err(ScannedFileReadError::Io(_))));
        assert_eq!(budget.remaining(), 12);
    }

    #[tokio::test]
    async fn operation_deadline_starts_before_root_io() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(
                temp.path().join("plugins"),
                PluginPackageScope::Workspace,
            )],
            temp.path().join("trust.json"),
        );
        let mut budget = OperationScanBudget::with_limits(1024, Duration::ZERO);

        let discovery = store.discover_with_budget(&mut budget).await;

        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::ScanBudgetExceeded
        );
    }

    #[tokio::test]
    async fn trust_lock_wait_is_bounded_by_the_operation_deadline() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ProductPluginSourceStore::new(Vec::new(), temp.path().join("trust.json"));
        let owner_budget = OperationScanBudget::with_limits(1024, Duration::from_secs(1));
        let _owner = store
            .acquire_trust_file_lock(&owner_budget)
            .await
            .expect("acquire owner lock");
        let contender_budget = OperationScanBudget::with_limits(1024, Duration::from_millis(75));
        let started = Instant::now();

        let error = store
            .acquire_trust_file_lock(&contender_budget)
            .await
            .expect_err("contended lock must time out");

        assert!(matches!(error, PluginSourceStoreError::TrustLockTimeout));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[tokio::test]
    async fn expired_operation_does_not_acquire_an_available_trust_lock() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ProductPluginSourceStore::new(Vec::new(), temp.path().join("trust.json"));
        let expired = OperationScanBudget::with_limits(1024, Duration::ZERO);

        let error = store
            .acquire_trust_file_lock(&expired)
            .await
            .expect_err("expired operation must not acquire a free lock");

        assert!(matches!(error, PluginSourceStoreError::TrustLockTimeout));
    }

    #[tokio::test]
    async fn cancelled_transaction_keeps_the_lock_until_blocking_work_finishes() {
        let temp = tempfile::tempdir().expect("tempdir");
        let store = ProductPluginSourceStore::new(Vec::new(), temp.path().join("trust.json"));
        let owner_budget = OperationScanBudget::with_limits(1024, Duration::from_secs(1));
        let mut owner = store
            .acquire_trust_file_lock(&owner_budget)
            .await
            .expect("acquire owner lock");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let transaction = tokio::spawn(async move {
            owner
                .run_blocking(move || {
                    started_tx.send(()).expect("signal worker start");
                    release_rx.recv().expect("wait for worker release");
                    Ok(())
                })
                .await
        });
        tokio::task::spawn_blocking(move || started_rx.recv().expect("wait for worker start"))
            .await
            .expect("join start waiter");

        transaction.abort();
        let contender_budget = OperationScanBudget::with_limits(1024, Duration::from_millis(75));
        let error = store
            .acquire_trust_file_lock(&contender_budget)
            .await
            .expect_err("cancelled async owner must not release worker lock");
        assert!(matches!(error, PluginSourceStoreError::TrustLockTimeout));

        release_tx.send(()).expect("release worker");
        let retry_budget = OperationScanBudget::with_limits(1024, Duration::from_secs(1));
        let _retry = store
            .acquire_trust_file_lock(&retry_budget)
            .await
            .expect("lock must release after blocking work finishes");
    }

    #[tokio::test]
    async fn failed_bounded_read_consumes_operation_budget() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let package_path = root.join("acme.demo");
        tokio::fs::create_dir_all(&package_path)
            .await
            .expect("create package");
        tokio::fs::write(package_path.join("oversized.bin"), b"four")
            .await
            .expect("write oversized fixture");

        let root_config = PluginPackageRoot::new(root, PluginPackageScope::Workspace);
        let secure_root = SecureManagedRoot::open(&root_config).expect("open managed root");
        let secure_package = secure_root
            .open_package(std::ffi::OsStr::new("acme.demo"))
            .expect("open package");
        let mut budget = OperationScanBudget::with_limits(3, Duration::from_secs(30));

        let result =
            read_scanned_file(&secure_package, Path::new("oversized.bin"), 10, &mut budget).await;

        assert!(matches!(result, Err(ScannedFileReadError::BudgetExceeded)));
        assert_eq!(budget.remaining(), 0);
    }

    async fn write_package(root: &Path, id: &str, source: &[u8], declared_hash: &str) {
        let package = root.join(id);
        let plugin_dir = package.join("plugin");
        tokio::fs::create_dir_all(&plugin_dir)
            .await
            .expect("create package directories");
        tokio::fs::write(plugin_dir.join("demo.ts"), source)
            .await
            .expect("write plugin source");
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "id": id,
            "version": "1.0.0",
            "adapter": "test_adapter",
            "files": [{
                "path": "plugin/demo.ts",
                "sha256": declared_hash,
            }],
        });
        tokio::fs::write(
            package.join("openbitfun.plugin.json"),
            serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
        )
        .await
        .expect("write manifest");
    }

    struct ManagedPluginFixture {
        _temp: tempfile::TempDir,
        workspace: PathBuf,
        workspace_root: PathBuf,
        trust_path: PathBuf,
    }

    impl ManagedPluginFixture {
        async fn new() -> Self {
            let temp = tempfile::tempdir().expect("tempdir");
            let workspace = temp.path().join("workspace");
            let fixture = Self {
                workspace_root: workspace.join(".openbitfun/plugins"),
                trust_path: temp.path().join("state/trust.json"),
                workspace,
                _temp: temp,
            };
            tokio::fs::create_dir_all(fixture._temp.path().join("user/plugins"))
                .await
                .expect("create user root");
            fixture
                .write("acme.demo", b"export const Version = 1;")
                .await;
            fixture
        }

        fn service(&self) -> ManagedPluginSourceService {
            ManagedPluginSourceService::new(
                self._temp.path().join("user/plugins"),
                self._temp.path().join("user"),
                self.workspace_root.clone(),
                self.workspace.clone(),
                self.trust_path.clone(),
            )
        }

        async fn write(&self, id: &str, source: &[u8]) {
            write_package(&self.workspace_root, id, source, &sha256(source)).await;
        }

        async fn activate(
            &self,
            service: &ManagedPluginSourceService,
            id: &str,
        ) -> super::PluginActivationAuthority {
            service
                .set_trust(&self.workspace, id, PluginTrustDecision::ApproveSource)
                .await
                .expect("approve source");
            let content_hash = self.content_hash(service, id).await;
            service
                .activate(&self.workspace, id, Some(&content_hash))
                .await
                .expect("activate package");
            service
                .load_activated_package(&self.workspace, id)
                .await
                .expect("load activated package")
                .1
        }

        async fn content_hash(&self, service: &ManagedPluginSourceService, id: &str) -> String {
            service
                .load_package(&self.workspace, id)
                .await
                .expect("load package")
                .into_parts()
                .1
                .content_hash
        }

        async fn authority(
            &self,
            service: &ManagedPluginSourceService,
            authority: &super::PluginActivationAuthority,
        ) -> bool {
            service
                .has_activation_authority(&self.workspace, "acme.demo", authority)
                .await
                .expect("check activation authority")
        }
    }

    #[tokio::test]
    async fn activation_requires_source_approval_without_persisting_partial_state() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();

        let content_hash = service.store.discover().await.packages[0]
            .identity
            .content_hash
            .clone();
        let error = service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect_err("unapproved source must not activate");

        assert!(matches!(
            error,
            ManagedPluginSourceError::PackageInvalid { .. }
        ));
        assert!(!fixture.trust_path.exists());
    }

    #[tokio::test]
    async fn activation_rejects_missing_or_stale_content_confirmation() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        service
            .set_trust(
                &fixture.workspace,
                "acme.demo",
                PluginTrustDecision::ApproveSource,
            )
            .await
            .expect("approve source");

        for expected in [None, Some("sha256:stale")] {
            let error = service
                .activate(&fixture.workspace, "acme.demo", expected)
                .await
                .expect_err("confirmation must match the selected package");
            assert!(matches!(
                error,
                ManagedPluginSourceError::PackageInvalid { .. }
            ));
        }
        assert!(!service.refresh(&fixture.workspace).await.packages[0].activated);
    }

    #[test]
    fn activation_contract_errors_distinguish_package_state_from_store_failures() {
        let package_error = map_activation_store_error(
            "acme.demo",
            PluginSourceStoreError::Contract(
                PluginSourceContractError::ActivationRequiresSourceApproval,
            ),
        );
        let store_error = map_activation_store_error(
            "acme.demo",
            PluginSourceStoreError::Contract(PluginSourceContractError::ActivationEpochExhausted),
        );

        assert!(matches!(
            package_error,
            ManagedPluginSourceError::PackageInvalid { .. }
        ));
        assert!(matches!(
            store_error,
            ManagedPluginSourceError::TrustStore(_)
        ));
    }

    #[tokio::test]
    async fn pre_openbitfun_trust_store_is_rejected_without_modification() {
        let fixture = ManagedPluginFixture::new().await;
        tokio::fs::create_dir_all(fixture.trust_path.parent().expect("trust state directory"))
            .await
            .expect("create trust state directory");
        let original = br#"{"schemaVersion":1,"epoch":7,"records":[]}"#;
        tokio::fs::write(&fixture.trust_path, original)
            .await
            .expect("write pre-OpenBitFun trust store");

        let snapshot = fixture.service().refresh(&fixture.workspace).await;
        let persisted = tokio::fs::read(&fixture.trust_path)
            .await
            .expect("read rejected trust store");

        assert_eq!(persisted, original);
        assert_eq!(snapshot.issues.len(), 1);
        assert_eq!(snapshot.issues[0].code, "trust_store_invalid");
        assert!(snapshot.issues[0].message.contains("pre-OpenBitFun"));
        assert!(snapshot.issues[0]
            .message
            .contains("explicit data migration tool"));
        assert!(snapshot.trust_epoch.is_none());
    }

    #[tokio::test]
    async fn activation_and_deactivation_are_exact_persisted_idempotent_state() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        service
            .set_trust(
                &fixture.workspace,
                "acme.demo",
                PluginTrustDecision::ApproveSource,
            )
            .await
            .expect("approve source");

        let content_hash = fixture.content_hash(&service, "acme.demo").await;
        let (activated, activated_changed) = service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect("activate package");
        let (activated_again, activated_again_changed) = service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect("repeat activation");
        assert!(activated.packages[0].activated);
        assert!(activated_changed);
        assert!(!activated_again_changed);
        assert_eq!(activated.activation_epoch, activated_again.activation_epoch);

        let recreated = fixture.service().refresh(&fixture.workspace).await;
        assert!(recreated.packages[0].activated);
        assert_eq!(activated.activation_epoch, recreated.activation_epoch);

        let (deactivated, deactivated_changed, _) = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("deactivate package");
        let (deactivated_again, deactivated_again_changed, _) = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("repeat deactivation");
        assert!(!deactivated.packages[0].activated);
        assert!(deactivated_changed);
        assert!(!deactivated_again_changed);
        assert_eq!(
            deactivated.activation_epoch,
            deactivated_again.activation_epoch
        );
        assert!(!fixture.service().refresh(&fixture.workspace).await.packages[0].activated);
    }

    #[tokio::test]
    async fn stale_rollback_cannot_clear_a_newer_activation() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        service
            .set_trust(
                &fixture.workspace,
                "acme.demo",
                PluginTrustDecision::ApproveSource,
            )
            .await
            .expect("approve source");
        let content_hash = fixture.content_hash(&service, "acme.demo").await;
        let (first, _) = service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect("activate package");
        let first_epoch = first.activation_epoch.expect("first activation epoch");

        service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("deactivate package");
        service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect("reactivate package");
        let current_authority = service
            .load_activated_package(&fixture.workspace, "acme.demo")
            .await
            .expect("load current activation")
            .1;
        tokio::fs::remove_dir_all(&fixture.workspace_root)
            .await
            .expect("remove plugin root");
        tokio::fs::write(&fixture.workspace_root, b"not a directory")
            .await
            .expect("make plugin root unreadable");

        let error = service
            .deactivate(&fixture.workspace, "acme.demo", Some(first_epoch))
            .await
            .expect_err("stale rollback must report the newer activation");
        assert!(matches!(
            error,
            ManagedPluginSourceError::TemporarilyUnavailable { .. }
        ));
        assert!(service
            .store
            .load_trust_store()
            .await
            .expect("load current trust state")
            .is_activation_current(&current_authority));
    }

    #[tokio::test]
    async fn deactivation_clears_a_missing_package_and_preserves_source_approval() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        let authority = fixture.activate(&service, "acme.demo").await;
        let (_, _, source, _) = authority.into_parts();
        let scope = workspace_scope(&fixture.workspace);
        tokio::fs::remove_dir_all(fixture.workspace_root.join("acme.demo"))
            .await
            .expect("remove package");

        let unavailable = service.refresh(&fixture.workspace).await;
        assert!(unavailable.issues.iter().any(|issue| {
            issue.code == "activation_source_unavailable" && issue.source_path == "acme.demo"
        }));
        let (deactivated, changed, cleared_source_available) = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("clear residual activation");
        assert!(changed);
        assert_eq!(cleared_source_available, Some(false));
        assert!(deactivated.discovery_complete);
        assert!(deactivated.packages.is_empty());

        let refreshed = service.refresh(&fixture.workspace).await;
        assert!(refreshed.packages.is_empty());

        let after = service
            .store
            .load_trust_store()
            .await
            .expect("load cleaned trust store");
        assert_eq!(
            after.trust_level_for(&scope.project_domain_id, &scope.workspace_id, &source),
            PluginPackageTrustLevel::SourceApproved
        );
        assert!(!after.is_activated(&scope.project_domain_id, &scope.workspace_id, &source));
    }

    #[tokio::test]
    async fn deactivation_clears_state_for_a_corrupt_package() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        fixture.activate(&service, "acme.demo").await;
        tokio::fs::write(
            fixture
                .workspace_root
                .join("acme.demo/openbitfun.plugin.json"),
            b"{not-json",
        )
        .await
        .expect("corrupt package manifest");

        let (deactivated, changed, cleared_source_available) = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("clear activation for corrupt package");
        assert!(changed);
        assert_eq!(cleared_source_available, Some(false));
        assert!(deactivated.discovery_complete);
        assert!(deactivated.packages.is_empty());
        assert!(deactivated
            .issues
            .iter()
            .any(|issue| issue.code == "invalid_manifest"));
    }

    #[tokio::test]
    async fn deactivation_invalidates_approval_for_a_replacement_source() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        let authority = fixture.activate(&service, "acme.demo").await;
        let (_, _, original, _) = authority.into_parts();
        fixture
            .write("acme.demo", b"export const Version = 2;")
            .await;

        let (deactivated, changed, cleared_source_available) = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("deactivate replaced package");
        assert!(changed);
        assert_eq!(cleared_source_available, Some(false));
        assert!(deactivated.discovery_complete);
        assert!(deactivated
            .packages
            .iter()
            .any(|package| package.package_id == "acme.demo"));
        let reconciled = service
            .store
            .load_trust_store()
            .await
            .expect("load reconciled trust store");
        assert_eq!(
            reconciled.trust_level_for(
                &workspace_scope(&fixture.workspace).project_domain_id,
                &workspace_scope(&fixture.workspace).workspace_id,
                &original,
            ),
            PluginPackageTrustLevel::Unknown
        );
    }

    #[tokio::test]
    async fn stale_residual_cleanup_cannot_clear_a_newer_activation() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        let stale = fixture.activate(&service, "acme.demo").await;
        service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("deactivate package");
        let current = fixture.activate(&service, "acme.demo").await;

        let scope = workspace_scope(&fixture.workspace);
        let (cleared_source, _, activation_epoch_mismatch) = service
            .store
            .clear_activation_record(
                &scope.project_domain_id,
                &scope.workspace_id,
                "acme.demo",
                Some(stale.activation_epoch()),
            )
            .await
            .expect("stale cleanup is a no-op");
        assert!(cleared_source.is_none());
        assert!(activation_epoch_mismatch);
        assert!(fixture.authority(&service, &current).await);
    }

    #[tokio::test]
    async fn uncertain_residual_cleanup_does_not_report_success() {
        fn fail_parent_sync(_parent: &Path) -> io::Result<()> {
            Err(io::Error::other("injected directory sync failure"))
        }

        let fixture = ManagedPluginFixture::new().await;
        let mut service = fixture.service();
        fixture.activate(&service, "acme.demo").await;
        tokio::fs::remove_dir_all(fixture.workspace_root.join("acme.demo"))
            .await
            .expect("remove package");
        service.store.parent_sync = fail_parent_sync;

        let error = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect_err("uncertain cleanup must not report success");

        assert!(matches!(
            error,
            ManagedPluginSourceError::DeactivationPersistenceUncertain { .. }
        ));
        assert!(error.to_string().contains("may not survive a system crash"));
    }

    #[tokio::test]
    async fn committed_activation_with_uncertain_directory_sync_returns_warning() {
        fn fail_parent_sync(_parent: &Path) -> io::Result<()> {
            Err(io::Error::other("injected directory sync failure"))
        }

        let fixture = ManagedPluginFixture::new().await;
        let mut service = fixture.service();
        service
            .set_trust(
                &fixture.workspace,
                "acme.demo",
                PluginTrustDecision::ApproveSource,
            )
            .await
            .expect("approve source");
        let content_hash = fixture.content_hash(&service, "acme.demo").await;
        service.store.parent_sync = fail_parent_sync;

        let (snapshot, changed) = service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect("committed activation remains successful");

        assert!(snapshot.packages[0].activated);
        assert!(changed);
        assert!(snapshot
            .issues
            .iter()
            .any(|issue| { issue.code == "activation_durability_uncertain" && !issue.is_error }));
    }

    #[tokio::test]
    async fn uncertain_deactivation_does_not_report_success() {
        static SYNC_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        fn fail_parent_sync_once(_parent: &Path) -> io::Result<()> {
            if SYNC_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                Err(io::Error::other("injected directory sync failure"))
            } else {
                Ok(())
            }
        }

        let fixture = ManagedPluginFixture::new().await;
        let mut service = fixture.service();
        fixture.activate(&service, "acme.demo").await;
        SYNC_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
        service.store.parent_sync = fail_parent_sync_once;

        let error = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect_err("uncertain deactivation must not report success");

        assert!(matches!(
            error,
            ManagedPluginSourceError::DeactivationPersistenceUncertain { .. }
        ));
        assert!(error.to_string().contains("may not survive a system crash"));

        let (_, changed, _) = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("retry must confirm the committed deactivation");
        assert!(!changed);
        assert_eq!(SYNC_CALLS.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn uncertain_reconciliation_after_deactivation_does_not_report_success() {
        static SYNC_CALLS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        fn fail_second_parent_sync(_parent: &Path) -> io::Result<()> {
            if SYNC_CALLS.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                Err(io::Error::other("injected reconciliation sync failure"))
            } else {
                Ok(())
            }
        }

        let fixture = ManagedPluginFixture::new().await;
        let mut service = fixture.service();
        fixture.activate(&service, "acme.demo").await;
        fixture
            .write("acme.demo", b"export const Version = 2;")
            .await;
        SYNC_CALLS.store(0, std::sync::atomic::Ordering::SeqCst);
        service.store.parent_sync = fail_second_parent_sync;

        let error = service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect_err("uncertain source reconciliation must not report success");

        assert!(matches!(
            error,
            ManagedPluginSourceError::DeactivationPersistenceUncertain { .. }
        ));
        assert_eq!(SYNC_CALLS.load(std::sync::atomic::Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn activated_load_returns_authority_only_for_current_exact_identity() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        let evidence = fixture.activate(&service, "acme.demo").await;
        assert!(fixture.authority(&service, &evidence).await);

        fixture
            .write("acme.demo", b"export const Version = 2;")
            .await;
        assert!(service
            .load_activated_package(&fixture.workspace, "acme.demo")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn source_change_deny_and_revoke_atomically_remove_activation_authority() {
        let changed = ManagedPluginFixture::new().await;
        let changed_service = changed.service();
        let changed_evidence = changed.activate(&changed_service, "acme.demo").await;
        changed
            .write("acme.demo", b"export const Version = 2;")
            .await;
        assert!(!changed.authority(&changed_service, &changed_evidence).await);
        let changed_snapshot = changed_service.refresh(&changed.workspace).await;
        assert!(!changed_snapshot.packages[0].activated);

        for decision in [PluginTrustDecision::Denied, PluginTrustDecision::Revoked] {
            let fixture = ManagedPluginFixture::new().await;
            let service = fixture.service();
            let evidence = fixture.activate(&service, "acme.demo").await;

            let snapshot = service
                .set_trust(&fixture.workspace, "acme.demo", decision)
                .await
                .expect("invalidate source approval");
            assert!(!snapshot.packages[0].activated);
            assert!(!fixture.authority(&service, &evidence).await);
        }
    }

    #[tokio::test]
    async fn unrelated_activation_does_not_invalidate_existing_authority() {
        let fixture = ManagedPluginFixture::new().await;
        fixture
            .write("acme.other", b"export const Other = 1;")
            .await;
        let service = fixture.service();
        let retained = fixture.activate(&service, "acme.demo").await;
        fixture.activate(&service, "acme.other").await;
        assert!(fixture.authority(&service, &retained).await);
    }

    #[tokio::test]
    async fn recreated_activation_uses_a_different_generation() {
        let fixture = ManagedPluginFixture::new().await;
        let service = fixture.service();
        let first = fixture.activate(&service, "acme.demo").await;

        service
            .deactivate(&fixture.workspace, "acme.demo", None)
            .await
            .expect("deactivate package");
        let content_hash = fixture.content_hash(&service, "acme.demo").await;
        service
            .activate(&fixture.workspace, "acme.demo", Some(&content_hash))
            .await
            .expect("recreate activation");
        let second = service
            .load_activated_package(&fixture.workspace, "acme.demo")
            .await
            .expect("load recreated activation")
            .1;

        assert_ne!(first.activation_epoch(), second.activation_epoch());
        assert!(!fixture.authority(&service, &first).await);
        assert!(fixture.authority(&service, &second).await);
    }

    #[tokio::test]
    async fn discovery_keeps_valid_packages_and_isolates_invalid_packages() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let valid_source = b"export const Demo = async () => ({ tool: { ping: tool({}) } });";
        write_package(&root, "acme.valid", valid_source, &sha256(valid_source)).await;
        write_package(&root, "acme.invalid", b"changed", &sha256(b"expected")).await;

        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::User)],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert_eq!(discovery.packages.len(), 1);
        assert_eq!(discovery.packages[0].identity.package_id, "acme.valid");
        assert_eq!(discovery.packages[0].source_scope, PluginPackageScope::User);
        assert!(discovery.packages[0]
            .identity
            .content_hash
            .starts_with("sha256:"));
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::HashMismatch
        );
    }

    #[tokio::test]
    async fn unavailable_trust_store_does_not_project_an_epoch_or_trust_decision() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let source = b"export const Demo = true;";
        write_package(&root, "acme.demo", source, &sha256(source)).await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::User)],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;
        let scope = PluginTrustScope {
            project_domain_id: "project-1".to_string(),
            workspace_id: "workspace-1".to_string(),
        };

        let snapshot = build_snapshot(discovery, None, None, &scope);

        assert_eq!(snapshot.trust_epoch, None);
        assert_eq!(
            snapshot.packages[0].trust_level,
            PluginPackageTrustLevel::Unknown
        );
    }

    #[tokio::test]
    async fn recreated_trust_store_uses_a_new_epoch_generation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let trust_path = temp.path().join("trust.json");
        let store = ProductPluginSourceStore::new(Vec::new(), trust_path.clone());
        let first_epoch = store
            .load_trust_store()
            .await
            .expect("create first trust store")
            .epoch();
        tokio::fs::remove_file(&trust_path)
            .await
            .expect("remove first trust store");

        let second_epoch = store
            .load_trust_store()
            .await
            .expect("create replacement trust store")
            .epoch();

        assert_ne!(first_epoch, second_epoch);
    }

    #[test]
    fn trust_store_issues_distinguish_invalid_data_from_unavailable_io() {
        let invalid = PluginSourceStoreError::TrustDeserialize {
            path: "trust.json".into(),
            source: serde_json::from_str::<serde_json::Value>("{").expect_err("invalid json"),
        };
        let unavailable = PluginSourceStoreError::TrustLockIo(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "access denied",
        ));

        assert_eq!(trust_store_issue_code(&invalid), "trust_store_invalid");
        assert_eq!(
            trust_store_issue_code(&unavailable),
            "trust_store_unavailable"
        );
    }

    #[tokio::test]
    async fn workspace_package_shadows_user_package_with_the_same_id() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user_root = temp.path().join("user-plugins");
        let workspace_root = temp.path().join("workspace-plugins");
        let user_source = b"export const Source = 'user';";
        let workspace_source = b"export const Source = 'workspace';";
        write_package(&user_root, "acme.demo", user_source, &sha256(user_source)).await;
        write_package(
            &workspace_root,
            "acme.demo",
            workspace_source,
            &sha256(workspace_source),
        )
        .await;

        let store = ProductPluginSourceStore::new(
            vec![
                PluginPackageRoot::new(user_root, PluginPackageScope::User),
                PluginPackageRoot::new(workspace_root, PluginPackageScope::Workspace),
            ],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert_eq!(discovery.packages.len(), 1);
        assert_eq!(
            discovery.packages[0].source_scope,
            PluginPackageScope::Workspace
        );
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::ShadowedPackage
        );
        assert!(!discovery.issues[0].code.is_error());
    }

    #[tokio::test]
    async fn trust_update_reports_an_invalid_package_instead_of_not_found() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        write_package(&root, "acme.demo", b"changed", &sha256(b"expected")).await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)],
            temp.path().join("trust.json"),
        );

        let error = store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::ApproveSource,
                100,
            )
            .await
            .expect_err("invalid package cannot be source-approved");

        assert!(matches!(
            ManagedPluginSourceError::from(error),
            ManagedPluginSourceError::PackageInvalid { .. }
        ));
    }

    #[test]
    fn atomic_replace_failure_preserves_the_previous_trust_file() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("trust.json");
        std::fs::write(&target, b"old").expect("write old trust file");

        let result = replace_file_atomically(&temp.path().join("missing.tmp"), &target);

        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).expect("old trust file"), b"old");
    }

    #[test]
    fn atomic_replace_stage_failure_keeps_existing_target_and_replacement() {
        let temp = tempfile::tempdir().expect("tempdir");
        let replacement = temp.path().join("trust.tmp");
        let target = temp.path().join("trust.json");
        std::fs::write(&replacement, b"new").expect("write replacement");
        std::fs::create_dir(&target).expect("create invalid target directory");
        std::fs::write(target.join("old"), b"old").expect("write old target content");

        let result = replace_file_atomically(&replacement, &target);

        assert!(result.is_err());
        assert_eq!(
            std::fs::read(target.join("old")).expect("old target content"),
            b"old"
        );
        assert_eq!(
            std::fs::read(&replacement).expect("replacement remains recoverable"),
            b"new"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_partial_replace_failure_restores_the_backup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let backup = temp.path().join("trust.backup");
        let target = temp.path().join("trust.json");
        std::fs::write(&backup, b"old").expect("write simulated ReplaceFile backup");

        let result = super::restore_windows_backup_after_replace_failure(
            &backup,
            &target,
            io::Error::other("injected partial ReplaceFile failure"),
        );

        assert!(result.is_err());
        assert_eq!(std::fs::read(&target).expect("restored target"), b"old");
        assert!(!backup.exists());
    }

    #[test]
    fn directory_sync_failure_reports_committed_state_as_uncertain() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("trust.json");
        std::fs::write(&target, b"old").expect("write old trust file");

        let error = persist_trust_bytes_with_parent_sync(&target, b"new", |_| {
            Err(io::Error::other("injected directory sync failure"))
        })
        .expect_err("directory sync failure must be explicit");

        assert!(matches!(
            error,
            PluginSourceStoreError::TrustDurabilityUncertain { .. }
        ));
        assert_eq!(
            std::fs::read(&target).expect("read committed state"),
            b"new"
        );
    }

    #[test]
    fn mismatched_readback_is_not_reported_as_committed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("trust.json");
        std::fs::write(&target, b"old").expect("write old trust file");
        let changed_target = target.clone();

        let error = persist_trust_bytes_with_parent_sync(&target, b"new", move |_| {
            std::fs::write(&changed_target, b"different")
        })
        .expect_err("mismatched readback must fail verification");

        assert!(matches!(
            error,
            PluginSourceStoreError::TrustCommitUnconfirmed { .. }
        ));
    }

    #[test]
    fn failed_parent_sync_with_mismatched_readback_is_not_a_durability_warning() {
        let temp = tempfile::tempdir().expect("tempdir");
        let target = temp.path().join("trust.json");
        std::fs::write(&target, b"old").expect("write old trust file");
        let changed_target = target.clone();

        let error = persist_trust_bytes_with_parent_sync(&target, b"new", move |_| {
            std::fs::write(&changed_target, b"different")?;
            Err(io::Error::other("injected directory sync failure"))
        })
        .expect_err("mismatched readback must fail verification");

        assert!(matches!(
            error,
            PluginSourceStoreError::TrustCommitUnconfirmed { .. }
        ));
    }

    #[tokio::test]
    async fn trust_generation_identity_detects_atomic_replacement() {
        let temp = tempfile::tempdir().expect("tempdir");
        let trust_path = temp.path().join("trust.json");
        let store = ProductPluginSourceStore::new(Vec::new(), trust_path.clone());
        let loaded = store
            .load_trust_store_generation()
            .await
            .expect("initialize trust store");
        let loaded_identity = loaded.identity.expect("persisted trust identity");
        let replacement = openbitfun_product_domains::plugin_source::PluginTrustStore::new(
            loaded.store.epoch().saturating_add(1),
        );

        store
            .persist_trust_store(&replacement)
            .await
            .expect("replace trust store");

        assert!(!store
            .trust_generation_matches(loaded_identity)
            .await
            .expect("compare trust generation"));
        let file = super::open_regular_file_no_follow(&trust_path).expect("open replacement");
        assert_ne!(
            trust_file_identity(&file).expect("replacement identity"),
            loaded_identity
        );
    }

    #[tokio::test]
    async fn trust_persistence_rejects_output_larger_than_the_read_limit() {
        let temp = tempfile::tempdir().expect("tempdir");
        let trust_path = temp.path().join("trust.json");
        let records = (0..1024)
            .map(|index| {
                serde_json::json!({
                    "projectDomainId": format!("p{index:04}{}", "a".repeat(249)),
                    "workspaceId": format!("w{index:04}{}", "b".repeat(249)),
                    "source": {
                        "packageId": "a".repeat(128),
                        "version": "v".repeat(128),
                        "adapter": "a".repeat(64),
                        "sourcePath": "s".repeat(256),
                        "contentHash": format!("sha256:{}", "a".repeat(64))
                    },
                    "trustLevel": "denied",
                    "updatedAtMs": index
                })
            })
            .collect::<Vec<_>>();
        let store: openbitfun_product_domains::plugin_source::PluginTrustStore =
            serde_json::from_value(serde_json::json!({
                "schemaVersion": 2,
                "epoch": 2,
                "records": records,
                "activationEpoch": 2,
                "activationRecords": []
            }))
            .expect("deserialize large trust store");
        store
            .validate()
            .expect("large trust store is structurally valid");
        let source_store = ProductPluginSourceStore::new(Vec::new(), trust_path.clone());

        let error = source_store
            .persist_trust_store(&store)
            .await
            .expect_err("oversized trust store must not be written");

        assert!(matches!(
            error,
            PluginSourceStoreError::TrustStoreTooLarge(size)
                if size as u64 > MAX_TRUST_STORE_BYTES
        ));
        assert!(!trust_path.exists());
    }

    #[cfg(windows)]
    #[test]
    fn native_path_identity_and_scope_do_not_collapse_lossy_utf16_paths() {
        use std::ffi::OsString;
        use std::os::windows::ffi::OsStringExt;

        let first = std::path::PathBuf::from(OsString::from_wide(&[0xd800]));
        let second = std::path::PathBuf::from(OsString::from_wide(&[0xd801]));

        assert_eq!(first.to_string_lossy(), second.to_string_lossy());
        assert_ne!(native_path_identity(&first), native_path_identity(&second));
        assert_ne!(
            workspace_scope(&first).workspace_id,
            workspace_scope(&second).workspace_id
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_containment_comparison_preserves_invalid_utf16_units() {
        let mut first = "\\\\?\\C:\\plugins\\".encode_utf16().collect::<Vec<_>>();
        first.push(0xd800);
        let mut child = first.clone();
        child.extend("\\declared.js".encode_utf16());
        let mut sibling = "\\\\?\\C:\\plugins\\".encode_utf16().collect::<Vec<_>>();
        sibling.push(0xd801);
        sibling.extend("\\declared.js".encode_utf16());

        assert!(super::windows_path_is_within(&child, &first));
        assert!(!super::windows_path_is_within(&sibling, &first));
    }

    #[cfg(windows)]
    #[test]
    fn windows_containment_does_not_merge_case_distinct_directories() {
        let root = "\\\\?\\C:\\plugins\\Foo".encode_utf16().collect::<Vec<_>>();
        let child = "\\\\?\\C:\\plugins\\Foo\\declared.js"
            .encode_utf16()
            .collect::<Vec<_>>();
        let sibling = "\\\\?\\C:\\plugins\\foo\\declared.js"
            .encode_utf16()
            .collect::<Vec<_>>();

        assert!(super::windows_path_is_within(&child, &root));
        assert!(!super::windows_path_is_within(&sibling, &root));
    }

    #[tokio::test]
    async fn invalid_workspace_package_does_not_fall_back_to_user_package() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user_root = temp.path().join("user-plugins");
        let workspace_root = temp.path().join("workspace-plugins");
        let source = b"export const Source = 'user';";
        write_package(&user_root, "acme.demo", source, &sha256(source)).await;
        write_package(
            &workspace_root,
            "acme.demo",
            b"tampered",
            &sha256(b"expected"),
        )
        .await;

        let store = ProductPluginSourceStore::new(
            vec![
                PluginPackageRoot::new(user_root, PluginPackageScope::User),
                PluginPackageRoot::new(workspace_root, PluginPackageScope::Workspace),
            ],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert!(discovery.packages.is_empty());
        assert!(discovery
            .issues
            .iter()
            .any(|issue| issue.code == PluginSourceIssueCode::HashMismatch));
        assert!(discovery
            .issues
            .iter()
            .any(|issue| issue.code == PluginSourceIssueCode::ShadowedPackage));
    }

    #[tokio::test]
    async fn workspace_package_suppresses_shadowed_user_package_errors() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user_root = temp.path().join("user-plugins");
        let workspace_root = temp.path().join("workspace-plugins");
        let workspace_source = b"export const Source = 'workspace';";
        write_package(&user_root, "acme.demo", b"tampered", &sha256(b"expected")).await;
        write_package(
            &workspace_root,
            "acme.demo",
            workspace_source,
            &sha256(workspace_source),
        )
        .await;

        let store = ProductPluginSourceStore::new(
            vec![
                PluginPackageRoot::new(user_root, PluginPackageScope::User),
                PluginPackageRoot::new(workspace_root, PluginPackageScope::Workspace),
            ],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert_eq!(discovery.packages.len(), 1);
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::ShadowedPackage
        );
    }

    #[tokio::test]
    async fn non_directory_workspace_entry_blocks_user_package_fallback() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user_root = temp.path().join("user-plugins");
        let workspace_root = temp.path().join("workspace-plugins");
        let source = b"export const Source = 'user';";
        write_package(&user_root, "acme.demo", source, &sha256(source)).await;
        tokio::fs::create_dir_all(&workspace_root)
            .await
            .expect("create workspace root");
        tokio::fs::write(workspace_root.join("acme.demo"), b"not a package directory")
            .await
            .expect("write blocking workspace entry");

        let store = ProductPluginSourceStore::new(
            vec![
                PluginPackageRoot::new(user_root, PluginPackageScope::User),
                PluginPackageRoot::new(workspace_root, PluginPackageScope::Workspace),
            ],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert!(discovery.packages.is_empty());
        assert!(discovery
            .issues
            .iter()
            .any(|issue| issue.code == PluginSourceIssueCode::InvalidPackageFile));
        assert!(discovery
            .issues
            .iter()
            .any(|issue| issue.code == PluginSourceIssueCode::ShadowedPackage));
    }

    #[tokio::test]
    async fn discovery_limits_identity_and_future_adapter_access_to_declared_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let source = b"export const Demo = async () => ({ tool: { ping: tool({}) } });";
        write_package(&root, "acme.demo", source, &sha256(source)).await;
        tokio::fs::create_dir_all(root.join("acme.demo/plugin/lib"))
            .await
            .expect("create nested package directory");
        tokio::fs::write(
            root.join("acme.demo/plugin/lib/undeclared.ts"),
            b"export const Hidden = async () => ({});",
        )
        .await
        .expect("write undeclared adapter file");

        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(
                root.clone(),
                PluginPackageScope::Workspace,
            )],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert_eq!(discovery.packages.len(), 1);
        assert!(discovery.issues.is_empty());
        assert!(discovery.packages[0].declared_files.is_none());
        assert_eq!(
            discovery.packages[0].identity.content_hash,
            PluginPackageManifest::parse_json(
                &tokio::fs::read_to_string(root.join("acme.demo/openbitfun.plugin.json"))
                    .await
                    .expect("read manifest")
            )
            .expect("parse manifest")
            .content_hash()
            .expect("hash manifest")
        );

        let mut budget = OperationScanBudget::new();
        let retained = store
            .discover_with_budget_for(&mut budget, Some("acme.demo"))
            .await;
        assert_eq!(
            retained.packages[0]
                .declared_files
                .as_ref()
                .expect("selected package content")
                .keys()
                .map(String::as_str)
                .collect::<Vec<_>>(),
            ["plugin/demo.ts"]
        );
    }

    #[tokio::test]
    async fn fixed_package_reads_are_serialized_per_service_instance() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let workspace_root = workspace.join(".openbitfun/plugins");
        let user_root = temp.path().join("user/plugins");
        tokio::fs::create_dir_all(&user_root)
            .await
            .expect("create user root");
        let source = b"export const Demo = async () => ({})";
        write_package(&workspace_root, "acme.demo", source, &sha256(source)).await;
        let service = std::sync::Arc::new(ManagedPluginSourceService::new(
            user_root,
            temp.path().join("user"),
            workspace_root,
            workspace.clone(),
            temp.path().join("trust.json"),
        ));
        service
            .set_trust(&workspace, "acme.demo", PluginTrustDecision::ApproveSource)
            .await
            .expect("approve source");
        let permit = service
            .load_gate
            .acquire()
            .await
            .expect("acquire load gate");
        let pending_service = service.clone();
        let pending_workspace = workspace.clone();
        let pending = tokio::spawn(async move {
            pending_service
                .load_package(&pending_workspace, "acme.demo")
                .await
        });

        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(!pending.is_finished());
        drop(permit);
        pending
            .await
            .expect("join fixed package read")
            .expect("load after gate release");
    }

    #[tokio::test]
    async fn unavailable_load_gate_is_reported_as_temporary() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let service = ManagedPluginSourceService::new(
            temp.path().join("user/plugins"),
            temp.path().join("user"),
            workspace.join(".openbitfun/plugins"),
            workspace.clone(),
            temp.path().join("trust.json"),
        );
        service.load_gate.close();

        let error = service
            .load_package(&workspace, "acme.demo")
            .await
            .expect_err("closed load gate must fail");

        assert!(matches!(
            error,
            ManagedPluginSourceError::TemporarilyUnavailable { .. }
        ));
    }

    #[test]
    fn retryable_store_failures_are_reported_as_temporary_load_errors() {
        for error in [
            PluginSourceStoreError::TrustLockTimeout,
            PluginSourceStoreError::TrustGenerationChanged,
            PluginSourceStoreError::SourceChanged,
            PluginSourceStoreError::TrustReadTask("cancelled".to_string()),
            PluginSourceStoreError::TrustLockTask("cancelled".to_string()),
            PluginSourceStoreError::TrustLockIo(io::Error::other("unavailable")),
            PluginSourceStoreError::TrustRead {
                path: PathBuf::from("trust.json"),
                source: io::Error::other("unavailable"),
            },
        ] {
            assert!(matches!(
                map_load_store_error("acme.demo", error),
                ManagedPluginSourceError::TemporarilyUnavailable { .. }
            ));
        }

        let invalid = PluginSourceStoreError::TrustRead {
            path: PathBuf::from("trust.json"),
            source: io::Error::new(ErrorKind::InvalidData, "invalid"),
        };
        assert!(matches!(
            map_load_store_error("acme.demo", invalid),
            ManagedPluginSourceError::TrustStore(_)
        ));
    }

    #[tokio::test]
    async fn selected_package_load_ignores_unrelated_invalid_package_content() {
        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let workspace_root = workspace.join(".openbitfun/plugins");
        let user_root = temp.path().join("user/plugins");
        tokio::fs::create_dir_all(&user_root)
            .await
            .expect("create user root");
        let source = b"export const Demo = async () => ({})";
        write_package(&workspace_root, "acme.demo", source, &sha256(source)).await;
        let service = ManagedPluginSourceService::new(
            user_root,
            temp.path().join("user"),
            workspace_root.clone(),
            workspace.clone(),
            temp.path().join("trust.json"),
        );
        service
            .set_trust(&workspace, "acme.demo", PluginTrustDecision::ApproveSource)
            .await
            .expect("approve source");
        tokio::fs::create_dir_all(workspace_root.join("broken.unrelated"))
            .await
            .expect("create unrelated package");
        tokio::fs::write(
            workspace_root.join("broken.unrelated/openbitfun.plugin.json"),
            b"not json",
        )
        .await
        .expect("write invalid unrelated manifest");

        service
            .load_package(&workspace, "acme.demo")
            .await
            .expect("unrelated package must not block selected load");
    }

    #[tokio::test]
    async fn final_trust_check_rejects_same_epoch_revocation() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("trust.json");
        let source = b"export const Demo = async () => ({})";
        write_package(&root, "acme.demo", source, &sha256(source)).await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)],
            trust_path.clone(),
        );
        let (discovery, approved) = store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::ApproveSource,
                1,
            )
            .await
            .expect("approve source");
        let approved_source = discovery.packages[0].identity.clone();
        let mut external: serde_json::Value =
            serde_json::from_slice(&tokio::fs::read(&trust_path).await.expect("read trust file"))
                .expect("parse trust file");
        external["records"][0]["trustLevel"] = serde_json::json!("revoked");
        tokio::fs::write(
            &trust_path,
            serde_json::to_vec_pretty(&external).expect("serialize external trust update"),
        )
        .await
        .expect("replace trust file with same epoch");
        let budget = OperationScanBudget::new();

        assert!(!store
            .trust_approval_matches(
                approved.epoch(),
                "project-1",
                "workspace-1",
                &approved_source,
                &budget,
            )
            .await
            .expect("check trust approval"));
    }

    #[tokio::test]
    async fn bounded_reads_reject_oversized_package_and_trust_files() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("state/trust.json");
        let oversized_source = vec![b'x'; MAX_PACKAGE_FILE_BYTES as usize + 1];
        write_package(
            &root,
            "acme.demo",
            &oversized_source,
            &sha256(&oversized_source),
        )
        .await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)],
            trust_path.clone(),
        );

        let discovery = store.discover().await;
        assert!(discovery.packages.is_empty());
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::FileTooLarge
        );

        tokio::fs::create_dir_all(trust_path.parent().expect("trust parent"))
            .await
            .expect("create trust parent");
        tokio::fs::write(&trust_path, vec![b' '; MAX_TRUST_STORE_BYTES as usize + 1])
            .await
            .expect("write oversized trust file");
        assert!(store.load_trust_store().await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_rejects_symbolic_links_in_declared_path_parents() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let package = root.join("acme.demo");
        let outside = temp.path().join("outside");
        let source = b"export const Demo = async () => ({});";
        tokio::fs::create_dir_all(&package)
            .await
            .expect("create package directory");
        tokio::fs::create_dir_all(&outside)
            .await
            .expect("create outside directory");
        tokio::fs::write(outside.join("demo.ts"), source)
            .await
            .expect("write outside source");
        symlink(&outside, package.join("plugin")).expect("create directory symlink");
        let manifest = serde_json::json!({
            "schemaVersion": 1,
            "id": "acme.demo",
            "version": "1.0.0",
            "adapter": "test_adapter",
            "files": [{
                "path": "plugin/demo.ts",
                "sha256": sha256(source),
            }],
        });
        tokio::fs::write(
            package.join("openbitfun.plugin.json"),
            serde_json::to_vec_pretty(&manifest).expect("serialize manifest"),
        )
        .await
        .expect("write manifest");

        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)],
            temp.path().join("trust.json"),
        );
        let discovery = store.discover().await;

        assert!(discovery.packages.is_empty());
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::SymlinkNotAllowed
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn discovery_rejects_windows_reparse_package_directories() {
        use std::os::windows::fs::symlink_dir;

        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let outside = temp.path().join("outside/acme.demo");
        tokio::fs::create_dir_all(&root)
            .await
            .expect("create plugin root");
        tokio::fs::create_dir_all(&outside)
            .await
            .expect("create outside package");
        if let Err(error) = symlink_dir(&outside, root.join("acme.demo")) {
            if error.kind() == std::io::ErrorKind::PermissionDenied
                || error.raw_os_error() == Some(1314)
            {
                return;
            }
            panic!("create directory symlink: {error}");
        }
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)],
            temp.path().join("trust.json"),
        );

        let discovery = store.discover().await;

        assert!(discovery.packages.is_empty());
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::SymlinkNotAllowed
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_rejects_linked_directories_between_containment_and_plugin_root() {
        use std::os::unix::fs::symlink;

        let temp = tempfile::tempdir().expect("tempdir");
        let workspace = temp.path().join("workspace");
        let outside = temp.path().join("outside");
        tokio::fs::create_dir_all(&workspace)
            .await
            .expect("create workspace");
        tokio::fs::create_dir_all(outside.join("plugins"))
            .await
            .expect("create outside plugins");
        symlink(&outside, workspace.join(".openbitfun")).expect("link workspace plugin parent");
        let root = workspace.join(".openbitfun/plugins");
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)
                .with_containment_root(workspace)],
            temp.path().join("trust.json"),
        );

        let discovery = store.discover().await;

        assert!(discovery.packages.is_empty());
        assert_eq!(discovery.issues.len(), 1);
        assert_eq!(
            discovery.issues[0].code,
            PluginSourceIssueCode::RootReadFailed
        );
    }

    #[tokio::test]
    async fn trust_store_persists_atomically_and_changed_sources_fail_closed() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("state/trust.json");
        let source = b"export const Demo = async () => ({ tool: { ping: tool({}) } });";
        write_package(&root, "acme.demo", source, &sha256(source)).await;

        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(
                root.clone(),
                PluginPackageScope::Workspace,
            )],
            trust_path.clone(),
        );
        let initial_epoch = store
            .load_trust_store()
            .await
            .expect("initialize trust store")
            .epoch();
        let discovered = store.discover().await;
        let identity = discovered.packages[0].identity.clone();
        let (_, source_approved) = store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::ApproveSource,
                100,
            )
            .await
            .expect("persist trust decision");
        assert_eq!(source_approved.epoch(), initial_epoch + 1);

        let reloaded = store.load_trust_store().await.expect("reload trust store");
        assert_eq!(
            reloaded.trust_level_for("project-1", "workspace-1", &identity),
            PluginPackageTrustLevel::SourceApproved
        );

        let changed_source = b"export const Demo = async () => ({ tool: { pong: tool({}) } });";
        write_package(&root, "acme.demo", changed_source, &sha256(changed_source)).await;
        let changed_discovery = store.discover().await;
        let changed_identity = changed_discovery.packages[0].identity.clone();
        let (_, reconciled) = store.reconcile_trust("project-1", "workspace-1").await;
        let reconciled = reconciled.expect("reconcile trust store");

        assert_eq!(reconciled.epoch(), initial_epoch + 2);
        assert_eq!(
            reconciled.trust_level_for("project-1", "workspace-1", &identity),
            PluginPackageTrustLevel::Unknown
        );
        assert_eq!(
            reconciled.trust_level_for("project-1", "workspace-1", &changed_identity),
            PluginPackageTrustLevel::Unknown
        );

        tokio::fs::write(&trust_path, b"{broken")
            .await
            .expect("corrupt trust store");
        assert!(store.load_trust_store().await.is_err());
        assert_eq!(
            tokio::fs::read(&trust_path)
                .await
                .expect("read corrupt file"),
            b"{broken"
        );
    }

    #[tokio::test]
    async fn incomplete_root_scan_preserves_existing_trust_records() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("state/trust.json");
        let source = b"export const Demo = async () => ({});";
        write_package(&root, "acme.demo", source, &sha256(source)).await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(
                root.clone(),
                PluginPackageScope::Workspace,
            )],
            trust_path,
        );
        let initial_epoch = store
            .load_trust_store()
            .await
            .expect("initialize trust store")
            .epoch();
        let discovered = store.discover().await;
        let identity = discovered.packages[0].identity.clone();
        store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::ApproveSource,
                100,
            )
            .await
            .expect("persist trust");

        tokio::fs::remove_dir_all(&root)
            .await
            .expect("remove plugin root");
        tokio::fs::write(&root, b"not a directory")
            .await
            .expect("replace plugin root with a file");
        let incomplete = store.discover().await;
        assert!(!incomplete.is_complete());
        let (_, preserved) = store.reconcile_trust("project-1", "workspace-1").await;
        let preserved = preserved.expect("preserve trust after incomplete scan");

        assert_eq!(preserved.epoch(), initial_epoch + 1);
        assert_eq!(
            preserved.trust_level_for("project-1", "workspace-1", &identity),
            PluginPackageTrustLevel::SourceApproved
        );
    }

    #[tokio::test]
    async fn invalid_revoke_does_not_commit_stale_identity_cleanup() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("state/trust.json");
        let original = b"export const Version = 1;";
        write_package(&root, "acme.demo", original, &sha256(original)).await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(
                root.clone(),
                PluginPackageScope::Workspace,
            )],
            trust_path,
        );
        let initial_epoch = store
            .load_trust_store()
            .await
            .expect("initialize trust store")
            .epoch();
        let original_discovery = store.discover().await;
        let original_identity = original_discovery.packages[0].identity.clone();
        store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::ApproveSource,
                100,
            )
            .await
            .expect("trust original identity");

        let changed = b"export const Version = 2;";
        write_package(&root, "acme.demo", changed, &sha256(changed)).await;
        assert!(store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::Revoked,
                200,
            )
            .await
            .is_err());

        let persisted = store.load_trust_store().await.expect("load trust store");
        assert_eq!(persisted.epoch(), initial_epoch + 1);
        assert_eq!(
            persisted.trust_level_for("project-1", "workspace-1", &original_identity),
            PluginPackageTrustLevel::SourceApproved
        );
    }

    #[tokio::test]
    async fn first_invalid_revoke_does_not_create_a_trust_store() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("state/trust.json");
        let source = b"export const Version = 1;";
        write_package(&root, "acme.demo", source, &sha256(source)).await;
        let store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(root, PluginPackageScope::Workspace)],
            trust_path.clone(),
        );

        let error = store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::Revoked,
                100,
            )
            .await
            .expect_err("an unapproved source cannot be revoked");

        assert!(matches!(
            error,
            PluginSourceStoreError::Contract(
                openbitfun_product_domains::plugin_source::PluginSourceContractError::InvalidTrustTransition
            )
        ));
        assert!(!trust_path.exists());
        let state_dir = trust_path.parent().expect("trust parent");
        for entry in std::fs::read_dir(state_dir).expect("read trust parent") {
            let name = entry
                .expect("trust parent entry")
                .file_name()
                .to_string_lossy()
                .into_owned();
            assert!(!name.ends_with(".tmp"), "unexpected temp file: {name}");
            assert!(!name.ends_with(".backup"), "unexpected backup file: {name}");
        }
    }

    #[tokio::test]
    async fn incomplete_workspace_scan_blocks_trust_writes_and_source_approval() {
        let temp = tempfile::tempdir().expect("tempdir");
        let user_root = temp.path().join("user-plugins");
        let workspace_root = temp.path().join("workspace-plugins");
        let trust_path = temp.path().join("state/trust.json");
        let source = b"export const Demo = async () => ({});";
        write_package(&user_root, "acme.demo", source, &sha256(source)).await;
        let user_store = ProductPluginSourceStore::new(
            vec![PluginPackageRoot::new(
                user_root.clone(),
                PluginPackageScope::User,
            )],
            trust_path.clone(),
        );
        user_store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::ApproveSource,
                100,
            )
            .await
            .expect("trust user package");
        tokio::fs::write(&workspace_root, b"not a directory")
            .await
            .expect("create invalid workspace root");
        let incomplete_store = ProductPluginSourceStore::new(
            vec![
                PluginPackageRoot::new(user_root, PluginPackageScope::User),
                PluginPackageRoot::new(workspace_root, PluginPackageScope::Workspace),
            ],
            trust_path,
        );

        assert!(incomplete_store
            .apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.demo",
                PluginTrustDecision::Denied,
                200,
            )
            .await
            .is_err());
        let (discovery, trust_store) = incomplete_store
            .reconcile_trust("project-1", "workspace-1")
            .await;
        let trust_store = trust_store.expect("read incomplete discovery");
        let scope = PluginTrustScope {
            project_domain_id: "project-1".to_string(),
            workspace_id: "workspace-1".to_string(),
        };
        let snapshot = build_snapshot(discovery, Some(trust_store), None, &scope);
        assert_eq!(snapshot.packages.len(), 1);
        assert_eq!(
            snapshot.packages[0].trust_level,
            PluginPackageTrustLevel::Unknown
        );
    }

    #[tokio::test]
    async fn trust_updates_from_separate_store_instances_do_not_overwrite_each_other() {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("plugins");
        let trust_path = temp.path().join("state/trust.json");
        let source = b"export const Demo = async () => ({});";
        write_package(&root, "acme.one", source, &sha256(source)).await;
        write_package(&root, "acme.two", source, &sha256(source)).await;

        let new_store = || {
            ProductPluginSourceStore::new(
                vec![PluginPackageRoot::new(
                    root.clone(),
                    PluginPackageScope::Workspace,
                )],
                trust_path.clone(),
            )
        };
        let first_store = new_store();
        let second_store = new_store();
        let initial_epoch = first_store
            .load_trust_store()
            .await
            .expect("initialize trust store")
            .epoch();
        let first_discovery = first_store.discover().await;
        let second_discovery = second_store.discover().await;
        let first_source = first_discovery
            .packages
            .iter()
            .find(|package| package.identity.package_id == "acme.one")
            .expect("first package")
            .identity
            .clone();
        let second_source = second_discovery
            .packages
            .iter()
            .find(|package| package.identity.package_id == "acme.two")
            .expect("second package")
            .identity
            .clone();

        let (first_result, second_result) = tokio::join!(
            first_store.apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.one",
                PluginTrustDecision::ApproveSource,
                100,
            ),
            second_store.apply_trust_decision(
                "project-1",
                "workspace-1",
                "acme.two",
                PluginTrustDecision::ApproveSource,
                101,
            ),
        );
        first_result.expect("persist first trust decision");
        second_result.expect("persist second trust decision");

        let stored = new_store()
            .load_trust_store()
            .await
            .expect("load merged trust store");
        assert_eq!(stored.epoch(), initial_epoch + 2);
        assert_eq!(
            stored.trust_level_for("project-1", "workspace-1", &first_source),
            PluginPackageTrustLevel::SourceApproved
        );
        assert_eq!(
            stored.trust_level_for("project-1", "workspace-1", &second_source),
            PluginPackageTrustLevel::SourceApproved
        );
    }
}
