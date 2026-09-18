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
use openbitfun_services_integrations::remote_persistence as owner;
use owner::{
    AccountHintRecord, AccountSessionRecord, BotChatStateRecord, BotConfigRecord,
    BotPersistenceRecord, LegacyAccountSessionKeyDomains, MachineBinding,
    RemoteConnectFormStateRecord, SavedBotConnectionRecord,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};

const DOMAIN_DIR: &str = "remote-connect";
const SOURCE_SCHEMA: &str = "bitfun.remote-connect.v0.2.19";
const TARGET_SCHEMA: &str = "openbitfun.remote-connect.current";
const MAX_REMOTE_FILES: usize = 4_096;
const MAX_SECRET_BYTES: u64 = 16 * 1024 * 1024;
const LEGACY_ACCOUNT_SESSION_KEY_DOMAINS: LegacyAccountSessionKeyDomains<'static> =
    LegacyAccountSessionKeyDomains {
        v1: b"BitFun::session_store::v1",
        v2: b"|BitFun::session_store::v2|",
    };

pub(crate) struct RemoteConnectAdapter;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum BotSourceKind {
    Canonical,
    Fallback,
    None,
    UnresolvedBackup,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteConnectManifest {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    omitted: Vec<String>,
    source_files: BTreeMap<String, String>,
    target_before: BTreeMap<String, Option<String>>,
    bot_source_kind: BotSourceKind,
    target_bot_unresolved: bool,
    imported: u64,
    skipped: u64,
    conflicts: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RemoteConnectReceipt {
    manifest_digest: String,
    completed: bool,
    post_files: BTreeMap<String, Option<String>>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct RemoteConnectOutcome {
    imported: u64,
    skipped: u64,
    conflicts: u64,
    warnings: Vec<MigrationDiagnostic>,
    requires_reauthentication: Vec<String>,
}

#[derive(Default)]
struct RemoteConnectState {
    omitted: Vec<String>,
    files: BTreeMap<String, String>,
    device: Option<owner::DeviceIdentityRecord>,
    account_session_present: bool,
    account_hint: Option<AccountHintRecord>,
    bot: Option<BotPersistenceRecord>,
    bot_source_kind: BotSourceKind,
    bot_unresolved: bool,
    weixin_sync: BTreeMap<String, String>,
    weixin_tokens: BTreeMap<String, BTreeMap<String, String>>,
}

impl Default for BotSourceKind {
    fn default() -> Self {
        Self::None
    }
}

impl LegacyDomainAdapter for RemoteConnectAdapter {
    fn domain(&self) -> MigrationDomainId {
        MigrationDomainId::RemoteConnectDevices
    }

    fn scan(&self, roots: &MigrationRoots) -> LegacyMigrationResult<DomainScan> {
        let source = read_state(&roots.legacy_home_root, true)?;
        let target = read_state(&roots.target_home_root, false)?;
        let preview = preview(&source, &target);
        Ok(DomainScan {
            finding: ScanFinding {
                domain: self.domain(),
                code: if !source.omitted.is_empty() {
                    "remote_items_skipped".to_string()
                } else if source.files.is_empty() {
                    "legacy_remote_connect_absent".to_string()
                } else {
                    "legacy_remote_connect_supported".to_string()
                },
                severity: if preview.conflicts.is_empty() && source.omitted.is_empty() {
                    FindingSeverity::Info
                } else {
                    FindingSeverity::Warning
                },
                entity_count: source_entity_count(&source),
                logical_bytes: total_bytes(&roots.legacy_home_root, source.files.keys())?,
                source_schema: Some(SOURCE_SCHEMA.to_string()),
                migratable: !source.bot_unresolved || source.files.len() > 1,
                detail: "Legacy Remote Connect identity, account, and bot stores were inspected without exposing credentials.".to_string(),
            },
            conflicts: preview.conflicts,
            target_schema: Some(TARGET_SCHEMA.to_string()),
            dependencies: Vec::new(),
        })
    }

    fn stage(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<MigrationDomainResult> {
        reset_stage(context)?;
        let source = read_state(&context.roots.legacy_home_root, true)?;
        let target = read_state(&context.roots.target_home_root, false)?;
        let preview = preview(&source, &target);
        let target_before = target_candidates(&source, &target)
            .into_iter()
            .map(|relative| {
                let digest = target.files.get(&relative).cloned();
                (relative, digest)
            })
            .collect();
        let manifest = RemoteConnectManifest {
            omitted: source.omitted,
            source_files: source.files,
            target_before,
            bot_source_kind: source.bot_source_kind,
            target_bot_unresolved: target.bot_unresolved,
            imported: preview.imported,
            skipped: preview.skipped,
            conflicts: preview.conflicts.len() as u64,
        };
        fs::create_dir_all(stage_domain_dir(context, DOMAIN_DIR))
            .map_err(|error| io_error(&stage_domain_dir(context, DOMAIN_DIR), error))?;
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
                .map(|path| remote_skipped_warning(path))
                .collect(),
            ..MigrationDomainResult::default()
        })
    }

    fn validate_stage(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_manifest(context)?;
        let source = read_state(&context.roots.legacy_home_root, true)?;
        if source.files != manifest.source_files
            || source.bot_source_kind != manifest.bot_source_kind
        {
            return Err(LegacyMigrationError::InvalidRequest(
                "legacy Remote Connect inputs changed after staging".to_string(),
            ));
        }
        if let Some(receipt) = read_optional_bounded_json::<RemoteConnectReceipt>(
            &context.layout.stage_root(),
            &receipt_path(context),
        )? {
            if receipt.manifest_digest != json_digest(&manifest)? {
                return Err(LegacyMigrationError::InvalidRequest(
                    "Remote Connect commit receipt does not match its staged manifest".to_string(),
                ));
            }
            return Ok(());
        }
        let target = read_state(&context.roots.target_home_root, false)?;
        if current_candidates(
            &context.roots.target_home_root,
            manifest.target_before.keys(),
        )? != manifest.target_before
            || target.bot_unresolved != manifest.target_bot_unresolved
        {
            return Err(LegacyMigrationError::InvalidRequest(
                "current Remote Connect data changed after staging".to_string(),
            ));
        }
        Ok(())
    }

    fn commit(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let manifest = read_manifest(context)?;
        let manifest_digest = json_digest(&manifest)?;
        let existing_receipt = read_optional_bounded_json::<RemoteConnectReceipt>(
            &context.layout.stage_root(),
            &receipt_path(context),
        )?;
        if let Some(receipt) = &existing_receipt {
            if receipt.manifest_digest != manifest_digest {
                return Err(LegacyMigrationError::InvalidRequest(
                    "Remote Connect commit receipt does not match its manifest".to_string(),
                ));
            }
            if receipt.completed
                && current_candidates(&context.roots.target_home_root, receipt.post_files.keys())?
                    == receipt.post_files
            {
                return Ok(());
            }
        } else {
            let current = current_candidates(
                &context.roots.target_home_root,
                manifest.target_before.keys(),
            )?;
            if current != manifest.target_before {
                return Err(LegacyMigrationError::InvalidRequest(
                    "current Remote Connect data changed before commit".to_string(),
                ));
            }
            backup_targets(context, &manifest.target_before)?;
            atomic_write_json(
                &receipt_path(context),
                &RemoteConnectReceipt {
                    manifest_digest: manifest_digest.clone(),
                    completed: false,
                    post_files: BTreeMap::new(),
                },
            )?;
        }

        let source = read_state(&context.roots.legacy_home_root, true)?;
        if source.files != manifest.source_files {
            return Err(LegacyMigrationError::InvalidRequest(
                "legacy Remote Connect inputs changed during commit".to_string(),
            ));
        }
        let original_root = backup_domain_dir(context, DOMAIN_DIR);
        let original = read_state(&original_root, false)?;
        let mut outcome = RemoteConnectOutcome {
            imported: manifest.imported,
            skipped: manifest.skipped,
            conflicts: manifest.conflicts,
            warnings: manifest
                .omitted
                .iter()
                .map(|path| remote_skipped_warning(path))
                .collect(),
            ..RemoteConnectOutcome::default()
        };
        if manifest.conflicts > 0 {
            outcome.warnings.push(warning(
                "remote_connect_conflicts_require_review",
                "One or more current Remote Connect records took priority or require owner recovery.",
            ));
        }
        if !manifest.source_files.is_empty() {
            apply_merge(context, &source, &original, &mut outcome)?;
        }

        let post_files = current_candidates(
            &context.roots.target_home_root,
            manifest.target_before.keys(),
        )?;
        atomic_write_json(&outcome_path(context), &outcome)?;
        atomic_write_json(
            &receipt_path(context),
            &RemoteConnectReceipt {
                manifest_digest,
                completed: true,
                post_files,
            },
        )
    }

    fn validate_commit(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let receipt: RemoteConnectReceipt =
            read_bounded_json(&context.layout.stage_root(), &receipt_path(context))?;
        if !receipt.completed
            || current_candidates(&context.roots.target_home_root, receipt.post_files.keys())?
                != receipt.post_files
        {
            return Err(LegacyMigrationError::InvalidRequest(
                "current Remote Connect owner did not retain the committed data".to_string(),
            ));
        }
        // Strict owner readers validate every installed active store. The
        // encrypted session is also decrypted here, never reported.
        let state = read_state(&context.roots.target_home_root, false)?;
        if state.account_session_present {
            owner::read_current_account_session(
                &context.roots.target_home_root,
                &MachineBinding::current(),
            )
            .map_err(owner_error)?;
        }
        Ok(())
    }

    fn finalize_result(
        &self,
        context: &DomainContext<'_>,
        staged: &MigrationDomainResult,
    ) -> LegacyMigrationResult<MigrationDomainResult> {
        let outcome: RemoteConnectOutcome =
            read_bounded_json(&context.layout.stage_root(), &outcome_path(context))?;
        let mut result = staged.clone();
        result.imported = outcome.imported;
        result.skipped = outcome.skipped;
        result.conflicts = outcome.conflicts;
        result.warnings = outcome.warnings;
        result.requires_reauthentication = outcome.requires_reauthentication;
        Ok(result)
    }

    fn rollback_unverified(&self, context: &DomainContext<'_>) -> LegacyMigrationResult<()> {
        let Some(manifest) = read_optional_bounded_json::<RemoteConnectManifest>(
            &context.layout.stage_root(),
            &manifest_path(context),
        )?
        else {
            return Ok(());
        };
        let backup_root = backup_domain_dir(context, DOMAIN_DIR);
        for (relative, digest) in &manifest.target_before {
            let target = context.roots.target_home_root.join(relative);
            let backup = backup_root.join(relative);
            restore_unverified_file(&target, &backup, digest.is_some())?;
        }
        Ok(())
    }
}

struct Preview {
    imported: u64,
    skipped: u64,
    conflicts: Vec<MigrationConflict>,
}

fn preview(source: &RemoteConnectState, target: &RemoteConnectState) -> Preview {
    let mut imported = 0;
    let mut skipped = source.omitted.len() as u64;
    let mut conflicts = Vec::new();
    if source.device.is_some() {
        if let Some(target_device) = &target.device {
            skipped += 1;
            if source.device.as_ref() != Some(target_device) {
                conflicts.push(target_wins(
                    "device_identity_target_wins",
                    "legacy device identity",
                    "current device identity",
                ));
            }
        } else {
            imported += 1;
        }
    }
    if source.account_session_present {
        if target.account_session_present {
            skipped += 1;
            conflicts.push(target_wins(
                "account_session_target_wins",
                "legacy account session",
                "current account session",
            ));
        } else {
            imported += 1;
        }
    }
    if source.account_hint.is_some() {
        imported += 1;
    }
    for connection in source
        .bot
        .as_ref()
        .into_iter()
        .flat_map(|bot| &bot.connections)
    {
        if target.bot.as_ref().is_some_and(|bot| {
            bot.connections
                .iter()
                .any(|candidate| candidate.bot_type == connection.bot_type)
        }) {
            skipped += 1;
            conflicts.push(target_wins(
                "bot_connection_target_wins",
                "legacy bot connection",
                "current bot connection",
            ));
        } else {
            imported += 1;
        }
    }
    if source.bot_unresolved {
        conflicts.push(MigrationConflict {
            domain: MigrationDomainId::RemoteConnectDevices,
            code: "legacy_bot_transaction_unresolved".to_string(),
            source_summary: "canonical bot persistence is missing while its backup exists"
                .to_string(),
            target_summary: "fallback bot persistence was not opened".to_string(),
            resolution: ConflictResolution::RequiresUserAction,
        });
    }
    if target.bot_unresolved {
        conflicts.push(MigrationConflict {
            domain: MigrationDomainId::RemoteConnectDevices,
            code: "target_bot_transaction_unresolved".to_string(),
            source_summary: "legacy bot persistence was left unchanged".to_string(),
            target_summary: "current bot persistence has an unresolved replacement backup"
                .to_string(),
            resolution: ConflictResolution::RequiresUserAction,
        });
    }
    Preview {
        imported,
        skipped,
        conflicts,
    }
}

fn target_wins(code: &str, source: &str, target: &str) -> MigrationConflict {
    MigrationConflict {
        domain: MigrationDomainId::RemoteConnectDevices,
        code: code.to_string(),
        source_summary: source.to_string(),
        target_summary: target.to_string(),
        resolution: ConflictResolution::TargetWins,
    }
}

fn apply_merge(
    context: &DomainContext<'_>,
    source: &RemoteConnectState,
    target: &RemoteConnectState,
    outcome: &mut RemoteConnectOutcome,
) -> LegacyMigrationResult<()> {
    let target_root = &context.roots.target_home_root;
    if target.device.is_none() {
        if let Some(device) = &source.device {
            owner::write_device_identity(&target_root.join("device_identity.json"), device)
                .map_err(owner_error)?;
        }
    }
    if let Some(source_hint) = &source.account_hint {
        let mut merged = target.account_hint.clone().unwrap_or_default();
        fill_empty(&mut merged.username, &source_hint.username);
        fill_empty(&mut merged.relay_url, &source_hint.relay_url);
        owner::write_account_hint(&target_root.join("account_hint.json"), &merged)
            .map_err(owner_error)?;
    }

    let binding = MachineBinding::current();
    let source_session = if source.account_session_present {
        match owner::read_legacy_account_session(
            &context.roots.legacy_home_root,
            &binding,
            LEGACY_ACCOUNT_SESSION_KEY_DOMAINS,
        ) {
            Ok(value) => value,
            Err(_) => {
                warn_reauthentication(
                    outcome,
                    "remote_connect_account",
                    "legacy_account_session_unavailable",
                    "The legacy Remote Connect account could not be securely transferred.",
                );
                None
            }
        }
    } else {
        None
    };
    let target_session = if target.account_session_present {
        match owner::read_current_account_session(&backup_domain_dir(context, DOMAIN_DIR), &binding)
        {
            Ok(value) => value,
            Err(_) => {
                warn_reauthentication(
                    outcome,
                    "remote_connect_account",
                    "target_account_session_unavailable",
                    "The existing Remote Connect account session needs authentication repair.",
                );
                None
            }
        }
    } else {
        None
    };
    if !target.account_session_present {
        if let Some(session) = &source_session {
            owner::write_current_account_session(target_root, &binding, session)
                .map_err(owner_error)?;
        }
    }

    let merged_bot = match (&source.bot, &target.bot) {
        (_, _) if target.bot_unresolved => {
            outcome.warnings.push(warning(
                "target_bot_transaction_unresolved",
                "Bot persistence was left unchanged because the current owner has an unresolved replacement backup.",
            ));
            None
        }
        (Some(source), Some(target)) => Some(merge_bot(source, target, true)),
        (Some(source), None) => Some(source.clone()),
        (None, Some(target)) => Some(target.clone()),
        (None, None) => None,
    };
    if let Some(bot) = &merged_bot {
        owner::write_bot_persistence(&target_root.join("remote_connect_persistence.json"), bot)
            .map_err(owner_error)?;
        merge_weixin_auxiliary(context, source, target, bot)?;
    }
    if source.bot_unresolved {
        outcome.warnings.push(warning(
            "legacy_bot_transaction_unresolved",
            "Fallback bot persistence was not restored because a canonical backup indicates an unresolved transaction.",
        ));
    }
    Ok(())
}

fn same_account(left: &AccountSessionRecord, right: &AccountSessionRecord) -> bool {
    left.user_id == right.user_id
        && normalized_url(&left.relay_url) == normalized_url(&right.relay_url)
}

fn normalized_url(value: &str) -> &str {
    value.trim().trim_end_matches('/')
}

fn merge_bot(
    source: &BotPersistenceRecord,
    target: &BotPersistenceRecord,
    target_present: bool,
) -> BotPersistenceRecord {
    let mut merged = target.clone();
    for source_connection in &source.connections {
        if let Some(target_connection) = merged
            .connections
            .iter_mut()
            .find(|candidate| candidate.bot_type == source_connection.bot_type)
        {
            merge_bot_connection(source_connection, target_connection);
        } else {
            merged.connections.push(source_connection.clone());
        }
    }
    merge_form_state(&source.form_state, &mut merged.form_state);
    if !target_present {
        merged.verbose_mode = source.verbose_mode;
    }
    merged
}

fn merge_bot_connection(source: &SavedBotConnectionRecord, target: &mut SavedBotConnectionRecord) {
    fill_empty(&mut target.chat_id, &source.chat_id);
    if target.connected_at == 0 {
        target.connected_at = source.connected_at;
    }
    merge_bot_config(&source.config, &mut target.config);
    merge_chat_state(&source.chat_state, &mut target.chat_state);
}

fn merge_bot_config(source: &BotConfigRecord, target: &mut BotConfigRecord) {
    match (source, target) {
        (
            BotConfigRecord::Feishu { app_id, app_secret },
            BotConfigRecord::Feishu {
                app_id: target_id,
                app_secret: target_secret,
            },
        ) => {
            fill_empty(target_id, app_id);
            fill_empty(target_secret, app_secret);
        }
        (
            BotConfigRecord::Telegram { bot_token },
            BotConfigRecord::Telegram {
                bot_token: target_token,
            },
        ) => fill_empty(target_token, bot_token),
        (
            BotConfigRecord::Weixin {
                ilink_token,
                base_url,
                bot_account_id,
            },
            BotConfigRecord::Weixin {
                ilink_token: target_token,
                base_url: target_url,
                bot_account_id: target_account,
            },
        ) => {
            fill_empty(target_token, ilink_token);
            fill_empty(target_url, base_url);
            fill_empty(target_account, bot_account_id);
        }
        _ => {}
    }
}

fn merge_chat_state(source: &BotChatStateRecord, target: &mut BotChatStateRecord) {
    fill_empty(&mut target.chat_id, &source.chat_id);
    let mut imported_source_context = false;
    if target.current_workspace.is_none() {
        target.current_workspace = source.current_workspace.clone();
        imported_source_context |= target.current_workspace.is_some();
    }
    if target.current_assistant.is_none() {
        target.current_assistant = source.current_assistant.clone();
        target.current_assistant_id = source.current_assistant_id.clone();
        imported_source_context |= target.current_assistant.is_some();
    }
    if target.current_assistant_name.is_none() {
        target.current_assistant_name = source.current_assistant_name.clone();
    }
    if target.current_session_id.is_none() {
        target.current_session_id = source.current_session_id.clone();
        imported_source_context |= target.current_session_id.is_some();
    }
    if imported_source_context {
        target.account_remote_context |= source.account_remote_context;
    }
}

fn merge_form_state(
    source: &RemoteConnectFormStateRecord,
    target: &mut RemoteConnectFormStateRecord,
) {
    fill_empty(&mut target.telegram_bot_token, &source.telegram_bot_token);
    fill_empty(&mut target.feishu_app_id, &source.feishu_app_id);
    fill_empty(&mut target.feishu_app_secret, &source.feishu_app_secret);
    fill_empty(&mut target.weixin_ilink_token, &source.weixin_ilink_token);
    fill_empty(&mut target.weixin_base_url, &source.weixin_base_url);
    fill_empty(
        &mut target.weixin_bot_account_id,
        &source.weixin_bot_account_id,
    );
}

fn fill_empty(target: &mut String, source: &str) {
    if target.trim().is_empty() && !source.trim().is_empty() {
        *target = source.to_string();
    }
}

fn merge_weixin_auxiliary(
    context: &DomainContext<'_>,
    source: &RemoteConnectState,
    target: &RemoteConnectState,
    merged: &BotPersistenceRecord,
) -> LegacyMigrationResult<()> {
    let active_ids = active_weixin_ids(merged)?;
    for account_id in active_ids {
        if let Some(source_buf) = source.weixin_sync.get(&account_id) {
            let target_path = weixin_sync_path(&context.roots.target_home_root, &account_id);
            if !target.files.contains_key(&home_relative(
                &context.roots.target_home_root,
                &target_path,
            )) {
                owner::write_weixin_sync_buffer(&target_path, source_buf).map_err(owner_error)?;
            }
        }
        if let Some(source_tokens) = source.weixin_tokens.get(&account_id) {
            let mut tokens = target
                .weixin_tokens
                .get(&account_id)
                .cloned()
                .unwrap_or_default();
            for (peer, token) in source_tokens {
                tokens.entry(peer.clone()).or_insert_with(|| token.clone());
            }
            owner::write_context_tokens(
                &weixin_tokens_path(&context.roots.target_home_root, &account_id),
                &tokens,
            )
            .map_err(owner_error)?;
        }
    }
    Ok(())
}

fn read_state(root: &Path, legacy: bool) -> LegacyMigrationResult<RemoteConnectState> {
    let mut state = RemoteConnectState::default();
    let device_path = root.join("device_identity.json");
    if source_file_exists(
        root,
        &device_path,
        MAX_JSON_BYTES,
        legacy,
        &mut state.omitted,
    )? {
        state.device = source_optional(
            owner::read_device_identity(&device_path).map_err(owner_error),
            legacy,
            "device_identity.json",
            &mut state.omitted,
        )?;
        record_file(root, &device_path, &mut state.files)?;
    }
    let hint_path = root.join("account_hint.json");
    if source_file_exists(root, &hint_path, MAX_JSON_BYTES, legacy, &mut state.omitted)? {
        state.account_hint = source_optional(
            owner::read_account_hint(&hint_path).map_err(owner_error),
            legacy,
            "account_hint.json",
            &mut state.omitted,
        )?;
        record_file(root, &hint_path, &mut state.files)?;
    }
    for name in ["account_session.enc", "account_session.key"] {
        let path = root.join(name);
        if source_file_exists(root, &path, MAX_SECRET_BYTES, legacy, &mut state.omitted)? {
            record_file(root, &path, &mut state.files)?;
        }
    }
    state.account_session_present = state.files.contains_key("account_session.enc");

    let canonical = root.join("remote_connect_persistence.json");
    let backup = root.join("remote_connect_persistence.json.bak");
    let fallback = root.join("bot_connections.json");
    let canonical_exists =
        source_file_exists(root, &canonical, MAX_JSON_BYTES, legacy, &mut state.omitted)?;
    let backup_exists =
        source_file_exists(root, &backup, MAX_JSON_BYTES, legacy, &mut state.omitted)?;
    let fallback_exists =
        source_file_exists(root, &fallback, MAX_JSON_BYTES, legacy, &mut state.omitted)?;
    for (path, exists) in [
        (&canonical, canonical_exists),
        (&backup, backup_exists),
        (&fallback, fallback_exists),
    ] {
        if exists {
            record_file(root, path, &mut state.files)?;
        }
    }
    if canonical_exists {
        state.bot = if legacy {
            read_source_bot(root, &canonical, &mut state.omitted)
        } else {
            owner::read_bot_persistence(&canonical).map_err(owner_error)?
        };
        state.bot_unresolved = state.bot.is_none();
        state.bot_source_kind = BotSourceKind::Canonical;
    } else if backup_exists {
        state.bot_unresolved = true;
        state.bot_source_kind = BotSourceKind::UnresolvedBackup;
    } else if legacy && fallback_exists {
        state.bot = read_source_bot(root, &fallback, &mut state.omitted);
        state.bot_source_kind = BotSourceKind::Fallback;
    }

    if let Some(bot) = &state.bot {
        for account_id in active_weixin_ids(bot)? {
            let sync_path = weixin_sync_path(root, &account_id);
            if source_file_exists(
                root,
                &sync_path,
                MAX_SECRET_BYTES,
                legacy,
                &mut state.omitted,
            )? {
                if let Some(value) = source_optional(
                    owner::read_weixin_sync_buffer(&sync_path).map_err(owner_error),
                    legacy,
                    "weixin/sync",
                    &mut state.omitted,
                )? {
                    state.weixin_sync.insert(account_id.clone(), value);
                }
                record_file(root, &sync_path, &mut state.files)?;
            }
            let token_path = weixin_tokens_path(root, &account_id);
            if source_file_exists(
                root,
                &token_path,
                MAX_JSON_BYTES,
                legacy,
                &mut state.omitted,
            )? {
                if let Some(value) = source_optional(
                    owner::read_context_tokens(&token_path).map_err(owner_error),
                    legacy,
                    "weixin/context_tokens",
                    &mut state.omitted,
                )? {
                    state.weixin_tokens.insert(account_id.clone(), value);
                }
                record_file(root, &token_path, &mut state.files)?;
            }
        }
    }
    Ok(state)
}

fn active_weixin_ids(bot: &BotPersistenceRecord) -> LegacyMigrationResult<BTreeSet<String>> {
    let mut ids = BTreeSet::new();
    for connection in &bot.connections {
        if let BotConfigRecord::Weixin { bot_account_id, .. } = &connection.config {
            if bot_account_id.is_empty() {
                continue;
            }
            if !owner::is_safe_weixin_account_id(bot_account_id) {
                return Err(LegacyMigrationError::InvalidRequest(
                    "Weixin bot account id is not a safe persistence component".to_string(),
                ));
            }
            ids.insert(bot_account_id.clone());
        }
    }
    Ok(ids)
}

fn target_candidates(source: &RemoteConnectState, target: &RemoteConnectState) -> BTreeSet<String> {
    let mut paths = target.files.keys().cloned().collect::<BTreeSet<_>>();
    paths.extend([
        "device_identity.json".to_string(),
        "account_hint.json".to_string(),
        "account_session.enc".to_string(),
        "account_session.key".to_string(),
        "remote_connect_persistence.json".to_string(),
    ]);
    for account_id in source.weixin_sync.keys().chain(source.weixin_tokens.keys()) {
        paths.insert(format!("weixin/{account_id}_get_updates_buf.txt"));
        paths.insert(format!("weixin/{account_id}_context_tokens.json"));
    }
    paths
}

fn current_candidates<'a>(
    root: &Path,
    candidates: impl IntoIterator<Item = &'a String>,
) -> LegacyMigrationResult<BTreeMap<String, Option<String>>> {
    let mut values = BTreeMap::new();
    for relative in candidates {
        let path = root.join(relative);
        let digest = match fs::symlink_metadata(&path) {
            Ok(_) => {
                validate_regular_file(root, &path)?;
                Some(file_digest(&path)?)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(&path, error)),
        };
        values.insert(relative.clone(), digest);
    }
    Ok(values)
}

fn backup_targets(
    context: &DomainContext<'_>,
    target_before: &BTreeMap<String, Option<String>>,
) -> LegacyMigrationResult<()> {
    let backup_root = backup_domain_dir(context, DOMAIN_DIR);
    for (relative, digest) in target_before {
        if digest.is_some() {
            let target = context.roots.target_home_root.join(relative);
            let backup = backup_root.join(relative);
            if is_secret_relative(relative) {
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

fn is_secret_relative(relative: &str) -> bool {
    matches!(
        relative,
        "account_session.enc"
            | "account_session.key"
            | "account_hint.json"
            | "remote_connect_persistence.json"
            | "remote_connect_persistence.json.bak"
            | "bot_connections.json"
    ) || relative.starts_with("weixin/")
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
                    "Remote Connect file exceeds {max_bytes} bytes: {}",
                    relative_display(root, path)
                )));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(path, error)),
    }
}

fn existing_directory(root: &Path, path: &Path) -> LegacyMigrationResult<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(LegacyMigrationError::InvalidRequest(format!(
                    "expected a regular Remote Connect directory at {}",
                    relative_display(root, path)
                )));
            }
            let canonical_root = fs::canonicalize(root).map_err(|error| io_error(root, error))?;
            let canonical_path = fs::canonicalize(path).map_err(|error| io_error(path, error))?;
            if !canonical_path.starts_with(canonical_root) {
                return Err(LegacyMigrationError::PathEscape(path.to_path_buf()));
            }
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(io_error(path, error)),
    }
}

fn record_file(
    root: &Path,
    path: &Path,
    files: &mut BTreeMap<String, String>,
) -> LegacyMigrationResult<()> {
    files.insert(home_relative(root, path), file_digest(path)?);
    Ok(())
}

fn home_relative(root: &Path, path: &Path) -> String {
    relative_display(root, path)
}

fn file_digest(path: &Path) -> LegacyMigrationResult<String> {
    let bytes = fs::read(path).map_err(|error| io_error(path, error))?;
    Ok(format!("sha256:{}", hex::encode(Sha256::digest(bytes))))
}

fn json_digest(value: &impl Serialize) -> LegacyMigrationResult<String> {
    let bytes = serde_json::to_vec(value).map_err(|error| {
        LegacyMigrationError::InvalidRequest(format!("serialize Remote Connect manifest: {error}"))
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

fn source_entity_count(state: &RemoteConnectState) -> u64 {
    u64::from(state.device.is_some())
        + u64::from(state.account_session_present)
        + u64::from(state.account_hint.is_some())
        + state
            .bot
            .as_ref()
            .map_or(0, |bot| bot.connections.len() as u64)
        + state.weixin_sync.len() as u64
        + state.weixin_tokens.len() as u64
}

fn weixin_sync_path(root: &Path, account_id: &str) -> PathBuf {
    root.join("weixin")
        .join(format!("{account_id}_get_updates_buf.txt"))
}

fn weixin_tokens_path(root: &Path, account_id: &str) -> PathBuf {
    root.join("weixin")
        .join(format!("{account_id}_context_tokens.json"))
}

fn warn_reauthentication(
    outcome: &mut RemoteConnectOutcome,
    identifier: &str,
    code: &str,
    message: &str,
) {
    outcome
        .requires_reauthentication
        .push(identifier.to_string());
    outcome.warnings.push(warning(code, message));
}

fn warning(code: &str, message: &str) -> MigrationDiagnostic {
    MigrationDiagnostic {
        code: code.to_string(),
        severity: FindingSeverity::Warning,
        domain: Some(MigrationDomainId::RemoteConnectDevices),
        message: message.to_string(),
        action: Some(
            "Review the item in Data Migrator and authenticate again if needed".to_string(),
        ),
        ..MigrationDiagnostic::default()
    }
}

fn owner_error(error: anyhow::Error) -> LegacyMigrationError {
    LegacyMigrationError::InvalidRequest(format!(
        "Remote Connect persistence owner rejected the data: {error:#}"
    ))
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

fn read_manifest(context: &DomainContext<'_>) -> LegacyMigrationResult<RemoteConnectManifest> {
    read_bounded_json(&context.layout.stage_root(), &manifest_path(context))
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

fn source_optional<T>(
    result: LegacyMigrationResult<Option<T>>,
    legacy: bool,
    path: &str,
    omitted: &mut Vec<String>,
) -> LegacyMigrationResult<Option<T>> {
    match result {
        Err(_) if legacy => {
            omitted.push(path.into());
            Ok(None)
        }
        other => other,
    }
}
fn remote_skipped_warning(path: &str) -> MigrationDiagnostic {
    MigrationDiagnostic {
        severity: FindingSeverity::Warning,
        domain: Some(MigrationDomainId::RemoteConnectDevices),
        code: "remote_items_skipped".into(),
        message: "An unreadable legacy remote record was omitted; other records remain available."
            .into(),
        relative_path: Some(path.into()),
        ..Default::default()
    }
}
fn read_source_bot(
    root: &Path,
    path: &Path,
    omitted: &mut Vec<String>,
) -> Option<BotPersistenceRecord> {
    let name = relative_display(root, path);
    let Ok(serde_json::Value::Object(mut fields)) =
        read_bounded_json::<serde_json::Value>(root, path)
    else {
        omitted.push(name);
        return None;
    };
    let mut bot = BotPersistenceRecord::default();
    if let Some(value) = fields.remove("form_state") {
        match serde_json::from_value(value) {
            Ok(value) => bot.form_state = value,
            Err(_) => omitted.push(format!("{name}/form_state")),
        }
    }
    bot.verbose_mode = fields
        .get("verbose_mode")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or_default();
    match fields.remove("connections") {
        Some(serde_json::Value::Array(values)) => {
            for (index, value) in values.into_iter().enumerate() {
                let label = format!("{name}/connections/{index}");
                let Ok(mut connection) = serde_json::from_value::<SavedBotConnectionRecord>(value)
                else {
                    omitted.push(label);
                    continue;
                };
                let kind = match &connection.config {
                    BotConfigRecord::Feishu { .. } => "feishu",
                    BotConfigRecord::Telegram { .. } => "telegram",
                    BotConfigRecord::Weixin { bot_account_id, .. } => {
                        if !bot_account_id.is_empty()
                            && !owner::is_safe_weixin_account_id(bot_account_id)
                        {
                            omitted.push(label);
                            continue;
                        }
                        "weixin"
                    }
                };
                connection.bot_type = kind.into();
                connection.chat_state.chat_id = connection.chat_id.clone();
                if bot.connections.iter().any(|other| other.bot_type == kind) {
                    omitted.push(label);
                    continue;
                }
                bot.connections.push(connection);
            }
        }
        Some(_) => omitted.push(format!("{name}/connections")),
        None => {}
    }
    Some(bot)
}

fn source_file_exists(
    root: &Path,
    path: &Path,
    limit: u64,
    legacy: bool,
    omitted: &mut Vec<String>,
) -> LegacyMigrationResult<bool> {
    match existing_regular(root, path, limit) {
        Err(_) if legacy => {
            omitted.push(relative_display(root, path));
            Ok(false)
        }
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adapters_for_groups;
    use openbitfun_legacy_migration::{
        probe_legacy_source, CancellationToken, CrashInjector, CrashPoint, LegacyMigrationError,
        MigrationEngine, NoCrashInjection, ProbeLimits,
    };
    use openbitfun_product_domains::legacy_migration::{
        MigrationGroupId, MigrationRunStatus, MigrationSelection,
    };
    use std::sync::atomic::{AtomicBool, Ordering};

    #[test]
    fn corrupt_remote_files_do_not_block_independent_data() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::write(root.join("device_identity.json"), b"broken JSON").unwrap();
        atomic_write_json(
            &root.join("remote_connect_persistence.json"),
            &serde_json::json!({"connections":[{"config":null}],"verbose_mode":true}),
        )
        .unwrap();
        let source = read_state(root, true).unwrap();
        assert!(source.device.is_none());
        assert!(source.bot.as_ref().unwrap().verbose_mode);
        assert_eq!(source.omitted.len(), 2);
        assert_eq!(source.files.len(), 2);
        assert!(read_state(root, false).is_err());
    }

    #[test]
    fn identical_device_identity_is_a_duplicate_without_a_conflict() {
        let device = owner::DeviceIdentityRecord {
            device_id: "11111111111111111111111111111111".into(),
            device_name: "device".into(),
            mac_address: "02:00:00:00:00:11".into(),
        };
        let source = RemoteConnectState {
            device: Some(device.clone()),
            ..Default::default()
        };
        let mut target = RemoteConnectState {
            device: Some(device),
            ..Default::default()
        };
        let duplicate = preview(&source, &target);
        assert_eq!(duplicate.imported, 0);
        assert_eq!(duplicate.skipped, 1);
        assert!(duplicate.conflicts.is_empty());
        target.device.as_mut().unwrap().device_name = "different".into();
        assert_eq!(
            preview(&source, &target).conflicts[0].code,
            "device_identity_target_wins"
        );
    }

    #[test]
    fn remote_connect_merge_preserves_target_identity_and_remote_bot_context() {
        let temp = test_tempdir("merge");
        let roots = fixture_roots(temp.path());
        seed_probe_source(&roots);
        fs::create_dir_all(&roots.legacy_home_root).unwrap();
        fs::create_dir_all(&roots.target_home_root).unwrap();
        let source_device = owner::DeviceIdentityRecord {
            device_id: "11111111111111111111111111111111".to_string(),
            device_name: "legacy-device".to_string(),
            mac_address: "02:00:00:00:00:11".to_string(),
        };
        let target_device = owner::DeviceIdentityRecord {
            device_id: "22222222222222222222222222222222".to_string(),
            device_name: "current-device".to_string(),
            mac_address: "02:00:00:00:00:22".to_string(),
        };
        owner::write_device_identity(
            &roots.legacy_home_root.join("device_identity.json"),
            &source_device,
        )
        .unwrap();
        owner::write_device_identity(
            &roots.target_home_root.join("device_identity.json"),
            &target_device,
        )
        .unwrap();
        let source_bot = bot_fixture("legacy-secret", Some("/srv/legacy"), true);
        let target_bot = bot_fixture("current-secret", None, false);
        owner::write_bot_persistence(
            &roots
                .legacy_home_root
                .join("remote_connect_persistence.json"),
            &source_bot,
        )
        .unwrap();
        owner::write_bot_persistence(
            &roots
                .target_home_root
                .join("remote_connect_persistence.json"),
            &target_bot,
        )
        .unwrap();
        // A syntactically valid encrypted envelope with the wrong key proves
        // credential failure is reported without blocking identity/bot data.
        fs::write(
            roots.legacy_home_root.join("account_session.enc"),
            "AAAAAAAAAAAAAAAAAAAA",
        )
        .unwrap();
        fs::write(
            roots.legacy_home_root.join("account_session.key"),
            [0u8; 32],
        )
        .unwrap();
        let before = source_hashes(&roots.legacy_home_root);

        let report = run_remote_group(&roots);
        assert_eq!(report.status, MigrationRunStatus::CompletedWithWarnings);
        assert_eq!(
            owner::read_device_identity(&roots.target_home_root.join("device_identity.json"))
                .unwrap(),
            Some(target_device)
        );
        let bot = owner::read_bot_persistence(
            &roots
                .target_home_root
                .join("remote_connect_persistence.json"),
        )
        .unwrap()
        .unwrap();
        let connection = &bot.connections[0];
        assert!(matches!(
            &connection.config,
            BotConfigRecord::Telegram { bot_token } if bot_token == "current-secret"
        ));
        assert_eq!(
            connection
                .chat_state
                .current_workspace
                .as_ref()
                .map(|workspace| workspace.path.as_str()),
            Some("/srv/legacy")
        );
        assert!(connection.chat_state.account_remote_context);
        assert!(report
            .requires_reauthentication
            .contains(&"remote_connect_account".to_string()));
        let report_json = serde_json::to_string(&report).unwrap();
        assert!(!report_json.contains("legacy-secret"));
        assert!(!report_json.contains("current-secret"));
        assert_eq!(source_hashes(&roots.legacy_home_root), before);
        assert_stage_redacted(&roots, &report.run_id, &["legacy-secret", "current-secret"]);
    }

    #[test]
    fn canonical_backup_blocks_legacy_bot_fallback() {
        let temp = test_tempdir("fallback");
        let roots = fixture_roots(temp.path());
        seed_probe_source(&roots);
        fs::create_dir_all(&roots.legacy_home_root).unwrap();
        owner::write_bot_persistence(
            &roots.legacy_home_root.join("bot_connections.json"),
            &bot_fixture("fallback-secret", None, false),
        )
        .unwrap();
        fs::write(
            roots
                .legacy_home_root
                .join("remote_connect_persistence.json.bak"),
            b"unresolved owner transaction",
        )
        .unwrap();

        let report = run_remote_group(&roots);
        assert_eq!(report.status, MigrationRunStatus::CompletedWithWarnings);
        assert!(!roots
            .target_home_root
            .join("remote_connect_persistence.json")
            .exists());
        let remote = report
            .domain_results
            .iter()
            .find(|result| result.domain == MigrationDomainId::RemoteConnectDevices)
            .unwrap();
        assert!(remote
            .warnings
            .iter()
            .any(|warning| warning.code == "legacy_bot_transaction_unresolved"));
        assert!(!serde_json::to_string(&report)
            .unwrap()
            .contains("fallback-secret"));
    }

    #[test]
    fn remote_connect_commit_resumes_after_the_owner_write_without_duplicates() {
        let temp = test_tempdir("crash-recovery");
        let roots = fixture_roots(temp.path());
        seed_probe_source(&roots);
        fs::create_dir_all(&roots.legacy_home_root).unwrap();
        owner::write_bot_persistence(
            &roots
                .legacy_home_root
                .join("remote_connect_persistence.json"),
            &bot_fixture("recovery-secret", Some("/srv/recovery"), true),
        )
        .unwrap();
        let source = probe_legacy_source(&roots, ProbeLimits::default())
            .unwrap()
            .unwrap();
        let selection = MigrationSelection {
            groups: BTreeSet::from([MigrationGroupId::RemoteConnectionsAndDevices]),
        };
        let engine = MigrationEngine::new(roots.clone(), adapters_for_groups(&selection)).unwrap();
        let plan = engine
            .plan(&source, selection, &CancellationToken::default())
            .unwrap();
        let crash = CrashOnce {
            point: CrashPoint::AfterCommit(MigrationDomainId::RemoteConnectDevices),
            fired: AtomicBool::new(false),
        };
        assert!(matches!(
            engine.execute(&plan, &CancellationToken::default(), &crash),
            Err(LegacyMigrationError::InjectedCrash(
                CrashPoint::AfterCommit(MigrationDomainId::RemoteConnectDevices)
            ))
        ));
        let report = engine
            .execute(&plan, &CancellationToken::default(), &NoCrashInjection)
            .unwrap();
        assert!(matches!(
            report.status,
            MigrationRunStatus::Completed | MigrationRunStatus::CompletedWithWarnings
        ));
        let bot = owner::read_bot_persistence(
            &roots
                .target_home_root
                .join("remote_connect_persistence.json"),
        )
        .unwrap()
        .unwrap();
        assert_eq!(bot.connections.len(), 1);
    }

    struct CrashOnce {
        point: CrashPoint,
        fired: AtomicBool,
    }

    impl CrashInjector for CrashOnce {
        fn should_crash(&self, point: CrashPoint) -> bool {
            point == self.point && !self.fired.swap(true, Ordering::AcqRel)
        }
    }

    fn bot_fixture(
        token: &str,
        workspace: Option<&str>,
        account_remote_context: bool,
    ) -> BotPersistenceRecord {
        BotPersistenceRecord {
            connections: vec![SavedBotConnectionRecord {
                account_user_id: String::new(),
                bot_type: "telegram".to_string(),
                chat_id: "chat-1".to_string(),
                config: BotConfigRecord::Telegram {
                    bot_token: token.to_string(),
                },
                chat_state: BotChatStateRecord {
                    chat_id: "chat-1".to_string(),
                    paired: true,
                    current_workspace: workspace.map(|path| owner::BotWorkspaceRefRecord {
                        workspace_id: None,
                        path: path.to_string(),
                        remote_connection_id: Some("ssh-user@example.invalid:22".to_string()),
                        remote_ssh_host: Some("example.invalid".to_string()),
                    }),
                    current_assistant: None,
                    current_assistant_id: None,
                    current_assistant_name: None,
                    current_session_id: None,
                    display_mode: owner::BotDisplayModeRecord::Assistant,
                    account_remote_context,
                },
                connected_at: 1,
            }],
            form_state: RemoteConnectFormStateRecord::default(),
            verbose_mode: false,
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
        let mut values = BTreeMap::new();
        for relative in [
            "device_identity.json",
            "remote_connect_persistence.json",
            "account_session.enc",
            "account_session.key",
        ] {
            let path = root.join(relative);
            if path.exists() {
                values.insert(relative.to_string(), file_digest(&path).unwrap());
            }
        }
        values
    }

    fn assert_stage_redacted(roots: &MigrationRoots, run_id: &str, secrets: &[&str]) {
        let stage = roots
            .migration_root()
            .join("runs")
            .join(run_id)
            .join("stage/remote-connect");
        for entry in fs::read_dir(stage).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                let contents = fs::read_to_string(path).unwrap();
                for secret in secrets {
                    assert!(!contents.contains(secret));
                }
            }
        }
    }

    fn test_tempdir(label: &str) -> tempfile::TempDir {
        let root = std::env::var_os("OPENBITFUN_TEST_TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        fs::create_dir_all(&root).unwrap();
        tempfile::Builder::new()
            .prefix(&format!("remote-connect-migration-{label}-"))
            .tempdir_in(root)
            .unwrap()
    }
}
