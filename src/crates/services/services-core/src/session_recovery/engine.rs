use super::*;
use anyhow::bail;

#[derive(Debug, Serialize, Deserialize)]
struct Journal {
    version: u32,
    plan_sha256: String,
    phase: String,
    controls: Vec<Control>,
    asset_writes: BTreeSet<PathBuf>,
    created_directories: BTreeSet<PathBuf>,
}
#[derive(Debug, Serialize, Deserialize)]
struct Control {
    path: PathBuf,
    old: Option<String>,
    new: Option<String>,
    backup: String,
    pending: Option<String>,
}

pub fn task_phase(task: &Path) -> Result<String> {
    if !task.join("journal.json").exists() {
        return Ok("planned".into());
    }
    let journal: Journal = serde_json::from_slice(&read(&task.join("journal.json"))?)?;
    ensure!(
        journal.version == FORMAT_VERSION
            && [
                "prepared",
                "indexing",
                "completed",
                "rolling_back",
                "rolled_back"
            ]
            .contains(&journal.phase.as_str()),
        "Unsupported repair journal"
    );
    Ok(journal.phase)
}
struct RepairLease {
    path: PathBuf,
    file: Option<fs::File>,
}
impl Drop for RepairLease {
    fn drop(&mut self) {
        drop(self.file.take());
        let _ = fs::remove_file(&self.path);
    }
}
fn lock(home: &Path) -> Result<RepairLease> {
    use std::io::Write;
    let path = home.join(".session-storage-repair.lock");
    safe(&path, home)?;
    // Shares the standalone script lock. Hard kills leave a sentinel requiring
    // deliberate cleanup after all repair writers stop.
    let file = fs::OpenOptions::new().write(true).create_new(true).open(&path)
        .context("Repair lock already exists or cannot be acquired. Close all repair tools; after an abnormal exit, remove the stale .session-storage-repair.lock before resuming")?;
    let mut lease = RepairLease {
        path,
        file: Some(file),
    };
    writeln!(lease.file.as_mut().unwrap(), "{}", std::process::id())?;
    lease.file.as_ref().unwrap().sync_all()?;
    Ok(lease)
}
fn save(task: &Path, journal: &Journal) -> Result<()> {
    write(&task.join("journal.json"), &encode(journal)?)
}
fn mutation_directories(plan: &RepairPlan) -> Result<BTreeSet<PathBuf>> {
    let projects = plan.home.join("projects");
    let mut result = BTreeSet::new();
    for operation in &plan.operations {
        for path in
            std::iter::once(&operation.target).chain(operation.assets.iter().map(|a| &a.target))
        {
            let mut directory = path.parent().context("Invalid repair target")?;
            while directory != projects {
                safe(directory, &projects)?;
                result.insert(directory.into());
                directory = directory.parent().context("Invalid repair directory")?;
            }
        }
    }
    Ok(result)
}
fn validate(plan: &RepairPlan) -> Result<()> {
    ensure!(
        plan.version == FORMAT_VERSION,
        "Unsupported repair plan version"
    );
    safe(&plan.home, &plan.home)?;
    safe(&plan.user_root, &plan.user_root)?;
    let (records, sha) = identity::registry(&plan.user_root)?;
    ensure!(
        sha == plan.registry_sha256,
        "Workspace registry changed; scan again"
    );
    let aliases = identity::aliases(&plan.home, &records)?;
    let mut sources = BTreeSet::new();
    let mut targets = BTreeSet::new();
    let mut affected = BTreeSet::new();
    for operation in &plan.operations {
        safe(&operation.source, &plan.home)?;
        safe(&operation.target, &plan.home.join("projects"))?;
        ensure!(
            safe_id(&operation.session_id)
                && filename(&operation.source)? == operation.session_id
                && operation
                    .source
                    .parent()
                    .is_some_and(|p| p.file_name().is_some_and(|n| n == "sessions")),
            "Invalid source session path"
        );
        let runtime = operation
            .source
            .parent()
            .unwrap()
            .parent()
            .context("Invalid runtime root")?;
        ensure!(
            runtime.parent() == Some(plan.home.join("projects").as_path())
                || runtime.starts_with(plan.home.join("remote_ssh")),
            "Invalid source runtime root"
        );
        let record = records
            .get(&operation.workspace_id)
            .context("Plan workspace is absent from registry")?;
        let expected = plan
            .home
            .join("projects")
            .join(identity::runtime_key(record)?)
            .join("sessions")
            .join(&operation.session_id);
        ensure!(
            expected == operation.target
                && sources.insert(operation.source.clone())
                && targets.insert(operation.target.clone()),
            "Invalid or duplicate repair destination"
        );
        affected.insert(operation.source.parent().unwrap().to_path_buf());
        affected.insert(operation.target.parent().unwrap().to_path_buf());
        let evidence = if operation.source.exists() {
            &operation.source
        } else {
            &operation.target
        };
        let mut docs = documents(evidence, None)?;
        for (name, update) in &operation.updates {
            ensure!(
                ["metadata.json", "state.json"].contains(&name.as_str()) && docs.contains_key(name),
                "Invalid identity update path"
            );
            let before = update
                .before
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(&update.before);
            docs.insert(name.clone(), serde_json::from_slice(before)?);
        }
        let owner = identity::owner(evidence, docs.clone(), &records, &aliases, None)?;
        ensure!(
            owner.id == operation.workspace_id && owner.root == operation.workspace_path,
            "Plan disagrees with session identity"
        );
        for (name, doc) in &docs {
            if let Some(update) = operation.updates.get(name) {
                ensure!(
                    doc != &owner.documents[name]
                        && update.after == encode(&owner.documents[name])?,
                    "Invalid assistant identity rewrite"
                );
            } else {
                ensure!(
                    doc == &owner.documents[name],
                    "Missing assistant identity rewrite"
                );
            }
        }
        ensure!(
            operation.source != operation.target || !operation.updates.is_empty(),
            "Plan has no repair action"
        );
        let (before_fingerprint, repaired_fingerprint) = directory_fingerprint_pair(
            evidence,
            &update_side(&operation.updates, true),
            &update_side(&operation.updates, false),
        )?;
        ensure!(
            before_fingerprint == operation.sha256
                && repaired_fingerprint == operation.repaired_sha256,
            "Session changed since planning"
        );
        let assets = identity::snapshot_assets(&operation.source, &operation.target, &owner)?;
        let comparable = |assets: &[Asset]| {
            assets
                .iter()
                .map(|a| (a.source.clone(), a.target.clone(), a.sha256.clone()))
                .collect::<Vec<_>>()
        };
        // Ignore destination presence during resume, but never ignore content.
        ensure!(
            comparable(&assets) == comparable(&operation.assets),
            "Snapshot dependencies changed since planning"
        );
    }
    ensure!(
        affected == plan.catalogs.keys().cloned().collect(),
        "Invalid affected session catalogs"
    );
    Ok(())
}
fn check_sessions(plan: &RepairPlan, resume: bool) -> Result<()> {
    let mut expected = plan.catalogs.clone();
    for operation in &plan.operations {
        let source = &operation.source;
        let target = &operation.target;
        let location = if source == target || source.exists() && !target.exists() {
            source
        } else if resume && target.exists() && !source.exists() {
            let sha = expected
                .get_mut(source.parent().unwrap())
                .unwrap()
                .remove(&operation.session_id)
                .context("Missing source catalog entry")?;
            expected
                .get_mut(target.parent().unwrap())
                .unwrap()
                .insert(operation.session_id.clone(), sha);
            target
        } else {
            bail!("Session source/destination conflict: {}", source.display());
        };
        for (name, update) in &operation.updates {
            let bytes = read(&location.join(name))?;
            ensure!(
                bytes == update.before || resume && bytes == update.after,
                "Session identity file changed: {}",
                location.join(name).display()
            );
        }
        ensure!(
            tree_hash(location, &update_side(&operation.updates, true))? == operation.sha256,
            "Session changed since planning: {}",
            location.display()
        );
        if operation.updates.contains_key("metadata.json") {
            expected
                .get_mut(location.parent().unwrap())
                .unwrap()
                .insert(
                    operation.session_id.clone(),
                    file_hash(&location.join("metadata.json"))?,
                );
        }
    }
    for (root, entries) in expected {
        ensure!(
            catalog(&root)? == entries,
            "Session catalog changed since planning: {}",
            root.display()
        );
    }
    Ok(())
}
fn copy_tree(source: &Path, target: &Path) -> Result<()> {
    safe(target, target)?;
    fs::create_dir_all(target)?;
    for child in children(source)? {
        let dest = target.join(filename(&child)?);
        if child.is_dir() {
            copy_tree(&child, &dest)?;
        } else {
            if dest.exists() {
                ensure!(
                    file_hash(&child)? == file_hash(&dest)?,
                    "Incomplete backup has conflicting content"
                );
            } else {
                copy_file(&child, &dest)?;
            }
        }
    }
    Ok(())
}
fn prepare_backup(
    plan: &RepairPlan,
    task: &Path,
    cancelled: &impl Fn() -> bool,
) -> Result<Journal> {
    let mut controls = vec![];
    for (number, operation) in plan.operations.iter().enumerate() {
        ensure!(!cancelled(), "Repair cancelled at a safe boundary");
        let backup = task.join("sessions").join(number.to_string());
        copy_tree(&operation.source, &backup)?;
        ensure!(
            tree_hash(&backup, &BTreeMap::new())? == operation.sha256,
            "Full-session backup verification failed"
        );
    }
    for root in plan.catalogs.keys() {
        for name in CONTROLS {
            let path = root.join(name);
            safe(&path, &plan.home)?;
            let old = optional_hash(&path)?;
            let backup = format!("controls/{}.bin", controls.len());
            if let Some(sha) = &old {
                write(&task.join(&backup), &read(&path)?)?;
                ensure!(
                    &file_hash(&task.join(&backup))? == sha,
                    "Control backup verification failed"
                );
            }
            controls.push(Control {
                path,
                old: old.clone(),
                new: old,
                backup,
                pending: None,
            });
        }
    }
    let journal = Journal {
        version: FORMAT_VERSION,
        plan_sha256: hash(&encode(plan)?),
        phase: "prepared".into(),
        controls,
        asset_writes: BTreeSet::new(),
        created_directories: mutation_directories(plan)?
            .into_iter()
            .filter(|p| !p.exists())
            .collect(),
    };
    save(task, &journal)?;
    Ok(journal)
}
fn load_backup(plan: &RepairPlan, task: &Path) -> Result<Journal> {
    let journal: Journal = serde_json::from_slice(&read(&task.join("journal.json"))?)?;
    ensure!(
        journal.version == FORMAT_VERSION && journal.plan_sha256 == hash(&encode(plan)?),
        "Backup belongs to another repair plan"
    );
    task_phase(task)?;
    ensure!(
        journal
            .created_directories
            .is_subset(&mutation_directories(plan)?),
        "Invalid repair directory journal"
    );
    for (number, operation) in plan.operations.iter().enumerate() {
        ensure!(
            tree_hash(
                &task.join("sessions").join(number.to_string()),
                &BTreeMap::new()
            )? == operation.sha256,
            "Session backup changed or is incomplete"
        );
    }
    let expected: BTreeSet<_> = plan
        .catalogs
        .keys()
        .flat_map(|root| CONTROLS.iter().map(|name| root.join(name)))
        .collect();
    ensure!(
        journal.controls.len() == expected.len()
            && journal
                .controls
                .iter()
                .map(|c| c.path.clone())
                .collect::<BTreeSet<_>>()
                == expected,
        "Invalid backup control paths"
    );
    for control in &journal.controls {
        let backup = task.join(&control.backup);
        safe(&backup, task)?;
        if let Some(old) = &control.old {
            ensure!(&file_hash(&backup)? == old, "Control backup changed");
        }
        if let Some(pending) = &control.pending {
            let path = task.join(pending);
            safe(&path, task)?;
            ensure!(
                Some(file_hash(&path)?) == control.new,
                "Pending index changed"
            );
        }
    }
    let assets = plan
        .operations
        .iter()
        .flat_map(|o| {
            o.assets
                .iter()
                .filter(|a| !a.existed)
                .map(|a| a.target.clone())
        })
        .collect();
    ensure!(
        journal.asset_writes.is_subset(&assets),
        "Invalid snapshot journal"
    );
    Ok(journal)
}
fn check_controls(journal: &Journal, home: &Path) -> Result<()> {
    for control in &journal.controls {
        safe(&control.path, home)?;
        let sha = optional_hash(&control.path)?;
        ensure!(
            sha == control.old || sha == control.new,
            "Session index/search cache changed: {}",
            control.path.display()
        );
    }
    Ok(())
}
/// Caller must stop all data writers. Cancellation is observed between whole
/// session actions, never halfway through an index or session identity write.
/// A returned error retains the journal and backups for resume/rollback.
pub fn apply(
    task: &Path,
    cancelled: impl Fn() -> bool,
    progress: impl Fn(usize, usize, &str),
) -> Result<()> {
    let plan = read_plan(task)?;
    outside_data(task, &plan)?;
    let _lock = lock(&plan.home)?;
    validate(&plan)?;
    let mut journal = if task.join("journal.json").exists() {
        let journal = load_backup(&plan, task)?;
        ensure!(
            !["rolling_back", "rolled_back"].contains(&journal.phase.as_str()),
            "Repair is rolling back or already rolled back"
        );
        check_sessions(&plan, true)?;
        journal
    } else {
        check_sessions(&plan, false)?;
        for operation in &plan.operations {
            for asset in &operation.assets {
                ensure!(
                    optional_hash(&asset.target)?.is_some() == asset.existed,
                    "Snapshot destination changed; scan again"
                );
            }
        }
        progress(0, plan.operations.len(), "backing_up");
        prepare_backup(&plan, task, &cancelled)?
    };
    check_controls(&journal, &plan.home)?;
    if journal.phase == "completed" {
        for operation in &plan.operations {
            ensure!(
                tree_hash(&operation.target, &BTreeMap::new())? == operation.repaired_sha256,
                "Completed repair session changed"
            );
        }
        for control in &journal.controls {
            ensure!(
                optional_hash(&control.path)? == control.new,
                "Completed repair controls changed"
            );
        }
        for asset in plan.operations.iter().flat_map(|o| &o.assets) {
            ensure!(
                optional_hash(&asset.target)? == Some(asset.sha256.clone()),
                "Completed repair snapshot changed"
            );
        }
        return Ok(());
    }
    for (number, operation) in plan.operations.iter().enumerate() {
        ensure!(!cancelled(), "Repair cancelled at a safe boundary");
        progress(number, plan.operations.len(), "repairing_sessions");
        for asset in &operation.assets {
            if let Some(sha) = optional_hash(&asset.target)? {
                ensure!(
                    sha == asset.sha256
                        && (asset.existed || journal.asset_writes.contains(&asset.target)),
                    "Snapshot changed or an unjournaled destination appeared"
                );
                continue;
            }
            ensure!(!asset.existed, "Existing snapshot disappeared");
            journal.asset_writes.insert(asset.target.clone());
            save(task, &journal)?;
            copy_file(&asset.source, &asset.target)?;
            ensure!(
                file_hash(&asset.target)? == asset.sha256,
                "Snapshot copy verification failed"
            );
        }
        if operation.source != operation.target && operation.source.exists() {
            fs::create_dir_all(operation.target.parent().unwrap())?;
            fs::rename(&operation.source, &operation.target)?;
        }
        for (name, update) in &operation.updates {
            if read(&operation.target.join(name))? != update.after {
                write(&operation.target.join(name), &update.after)?;
            }
        }
        ensure!(
            tree_hash(&operation.target, &BTreeMap::new())? == operation.repaired_sha256,
            "Repaired session verification failed"
        );
    }
    ensure!(!cancelled(), "Repair cancelled at a safe boundary");
    progress(
        plan.operations.len(),
        plan.operations.len(),
        "rebuilding_indexes",
    );
    if journal.phase == "prepared" {
        for (number, control) in journal.controls.iter_mut().enumerate() {
            if filename(&control.path)? == "index.json" {
                let bytes = index_bytes(control.path.parent().unwrap())?;
                let pending = format!("pending/{number}.json");
                write(&task.join(&pending), &bytes)?;
                control.new = Some(hash(&bytes));
                control.pending = Some(pending);
            } else {
                control.new = None;
            }
        }
        journal.phase = "indexing".into();
        save(task, &journal)?;
    }
    for control in &journal.controls {
        if let Some(pending) = &control.pending {
            write(&control.path, &read(&task.join(pending))?)?;
        } else if control.path.exists() {
            fs::remove_file(&control.path)?;
        }
    }
    check_sessions(&plan, true)?;
    journal.phase = "completed".into();
    save(task, &journal)?;
    progress(plan.operations.len(), plan.operations.len(), "completed");
    Ok(())
}
pub fn rollback(
    task: &Path,
    cancelled: impl Fn() -> bool,
    progress: impl Fn(usize, usize, &str),
) -> Result<()> {
    let plan = read_plan(task)?;
    outside_data(task, &plan)?;
    let _lock = lock(&plan.home)?;
    validate(&plan)?;
    let mut journal = load_backup(&plan, task)?;
    check_sessions(&plan, true)?;
    check_controls(&journal, &plan.home)?;
    for target in &journal.asset_writes {
        let asset = plan
            .operations
            .iter()
            .flat_map(|o| &o.assets)
            .find(|a| &a.target == target)
            .context("Unknown snapshot journal path")?;
        ensure!(
            optional_hash(target)?.is_none_or(|sha| sha == asset.sha256),
            "Copied snapshot changed; rollback refused"
        );
    }
    journal.phase = "rolling_back".into();
    save(task, &journal)?;
    for (number, operation) in plan.operations.iter().rev().enumerate() {
        ensure!(!cancelled(), "Repair cancelled at a safe boundary");
        progress(number, plan.operations.len(), "restoring_sessions");
        let location = if operation.target.exists() {
            &operation.target
        } else {
            &operation.source
        };
        for (name, update) in &operation.updates {
            if read(&location.join(name))? != update.before {
                write(&location.join(name), &update.before)?;
            }
        }
        if operation.source != operation.target && operation.target.exists() {
            fs::create_dir_all(operation.source.parent().unwrap())?;
            fs::rename(&operation.target, &operation.source)?;
        }
    }
    ensure!(!cancelled(), "Repair cancelled at a safe boundary");
    for control in &journal.controls {
        if control.old.is_some() {
            write(&control.path, &read(&task.join(&control.backup))?)?;
        } else if control.path.exists() {
            fs::remove_file(&control.path)?;
        }
    }
    for target in &journal.asset_writes {
        if target.exists() {
            fs::remove_file(target)?;
        }
    }
    let mut directories: Vec<_> = journal.created_directories.iter().collect();
    directories.sort_by_key(|p| std::cmp::Reverse(p.components().count()));
    for directory in directories {
        match fs::remove_dir(directory) {
            Ok(()) => {}
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(e) => return Err(e.into()),
        }
    }
    journal.phase = "rolled_back".into();
    save(task, &journal)?;
    progress(plan.operations.len(), plan.operations.len(), "rolled_back");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session_recovery::tests::Fixture;

    #[test]
    fn torn_index_publication_and_rollback_resume_from_durable_journal() {
        for roll_back in [false, true] {
            let f = Fixture::new();
            let plan = f.prepare();
            let mut journal = prepare_backup(&plan, &f.task, &|| false).unwrap();
            let op = &plan.operations[0];
            fs::create_dir_all(op.target.parent().unwrap()).unwrap();
            fs::rename(&op.source, &op.target).unwrap();
            for (number, control) in journal.controls.iter_mut().enumerate() {
                if filename(&control.path).unwrap() == "index.json" {
                    let bytes = index_bytes(control.path.parent().unwrap()).unwrap();
                    let pending = format!("pending/{number}.json");
                    write(&f.task.join(&pending), &bytes).unwrap();
                    control.new = Some(hash(&bytes));
                    control.pending = Some(pending);
                } else {
                    control.new = None;
                }
            }
            journal.phase = "indexing".into();
            save(&f.task, &journal).unwrap();
            let first = journal
                .controls
                .iter()
                .find(|c| c.path == f.source.parent().unwrap().join("index.json"))
                .unwrap();
            write(
                &first.path,
                &read(&f.task.join(first.pending.as_ref().unwrap())).unwrap(),
            )
            .unwrap();
            if roll_back {
                rollback(&f.task, || false, |_, _, _| {}).unwrap();
            } else {
                apply(&f.task, || false, |_, _, _| {}).unwrap();
                rollback(&f.task, || false, |_, _, _| {}).unwrap();
            }
            assert!(f.source.exists());
            assert_eq!(
                json(&first.path).unwrap(),
                serde_json::json!({"old":"index"})
            );
        }
    }

    #[test]
    fn identity_only_partial_rewrite_is_resumable_and_byte_exactly_reversible() {
        for resume in [false, true] {
            let mut f = Fixture::new();
            let root = f.home.join("personal_assistant/workspace-named");
            fs::create_dir_all(&root).unwrap();
            let old = f
                .home
                .with_file_name(".bitfun")
                .join("personal_assistant/workspace-named");
            let old_id = crate::workspace_identity::local_workspace_stable_storage_id(
                &old.to_str().unwrap().replace('\\', "/"),
            );
            let registry = serde_json::json!({"format_version":1,"product_id":"openbitfun","workspaces":{"new":{"id":"new","rootPath":root,"workspaceKind":"assistant"}}});
            write(
                &f.user.join("data/workspace_data.json"),
                &encode(&registry).unwrap(),
            )
            .unwrap();
            let target = f
                .home
                .join("projects")
                .join(crate::workspace_identity::local_workspace_runtime_key(
                    &crate::workspace_identity::normalize_local_workspace_root_for_stable_id(&root)
                        .unwrap(),
                ))
                .join("sessions/session-one");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::rename(&f.source, &target).unwrap();
            f.source = target;
            let mut meta = json(&f.source.join("metadata.json")).unwrap();
            meta["workspaceId"] = serde_json::json!(old_id);
            meta["workspacePath"] = serde_json::json!(old);
            write(&f.source.join("metadata.json"), &encode(&meta).unwrap()).unwrap();
            let state = serde_json::json!({"config":{"workspace_id":old_id,"workspace_path":old,"permission_mode":"full_access"}});
            write(&f.source.join("state.json"), &encode(&state).unwrap()).unwrap();
            let original = tree_hash(&f.source, &BTreeMap::new()).unwrap();
            let plan = f.prepare();
            assert_eq!(plan.operations.len(), 1);
            let op = &plan.operations[0];
            assert_eq!(op.source, op.target);
            assert_eq!(op.updates.len(), 2);
            prepare_backup(&plan, &f.task, &|| false).unwrap();
            write(
                &op.target.join("metadata.json"),
                &op.updates["metadata.json"].after,
            )
            .unwrap();
            if resume {
                apply(&f.task, || false, |_, _, _| {}).unwrap();
            }
            rollback(&f.task, || false, |_, _, _| {}).unwrap();
            assert_eq!(tree_hash(&f.source, &BTreeMap::new()).unwrap(), original);
        }
    }

    #[test]
    fn changed_user_data_refuses_rollback_and_script_lock_excludes_gui() {
        let f = Fixture::new();
        let plan = f.prepare();
        let lease = lock(&f.home).unwrap();
        assert!(apply(&f.task, || false, |_, _, _| {}).is_err());
        drop(lease);
        apply(&f.task, || false, |_, _, _| {}).unwrap();
        fs::write(
            plan.operations[0].target.join("new-user-turn"),
            "new content",
        )
        .unwrap();
        assert!(rollback(&f.task, || false, |_, _, _| {}).is_err());
        assert!(!f.source.exists());
        assert!(plan.operations[0].target.join("new-user-turn").exists());
    }
}
