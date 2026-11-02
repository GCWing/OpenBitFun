//! Workspace-owned icon operations. Assets stay on the catalog host, including SSH workspaces.
use super::*;
use openbitfun_core_types::workspace_icon::*;
use openbitfun_services_core::workspace_icon_assets::{
    normalize_icon, read_icon, store_icon, valid_asset_id,
};

fn icon_owner(manager: &WorkspaceManager, id: &str) -> Result<String, String> {
    let workspace = manager
        .get_workspaces()
        .get(id)
        .ok_or("Workspace not found")?;
    if workspace.workspace_kind == WorkspaceKind::Assistant {
        return Err("Assistant workspaces use assistant avatars".into());
    }
    let owner = workspace.project_workspace_id()?;
    if !manager.get_workspaces().contains_key(owner) {
        return Err("Project workspace is unavailable".into());
    }
    Ok(owner.to_string())
}

fn icon_record(workspace: &WorkspaceInfo) -> Result<WorkspaceIcon, String> {
    let icon: WorkspaceIcon = match workspace.metadata.get(WORKSPACE_ICON_METADATA_KEY) {
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|_| "Unreadable workspace icon configuration; data was preserved")?,
        None => WorkspaceIcon::default(),
    };
    if icon.version != WORKSPACE_ICON_VERSION
        || !valid_workspace_icon_color(&icon.color)
        || (icon.mode == WorkspaceIconMode::Image
            && !icon.asset_id.as_deref().is_some_and(valid_asset_id))
    {
        return Err("Unsupported workspace icon configuration; data was preserved".into());
    }
    Ok(icon)
}

async fn snapshot(
    root: PathBuf,
    workspace_id: String,
    icon: WorkspaceIcon,
) -> Result<WorkspaceIconSnapshot, String> {
    let (image, dark_image) = if icon.mode == WorkspaceIconMode::Image {
        let id = icon
            .asset_id
            .clone()
            .ok_or("Missing workspace icon asset")?;
        let dark_id = icon.dark_asset_id.clone();
        tokio::task::spawn_blocking(move || {
            (
                Some(read_icon(&root, &id)),
                dark_id.map(|id| read_icon(&root, &id)),
            )
        })
        .await
        .map_err(|e| e.to_string())?
    } else {
        (None, None)
    };
    let image_unavailable = matches!(&image, Some(Err(_)));
    let dark_image_unavailable = matches!(&dark_image, Some(Err(_)));
    Ok(WorkspaceIconSnapshot {
        workspace_id,
        icon,
        image_data: image.and_then(Result::ok),
        image_unavailable,
        dark_image_data: dark_image.and_then(Result::ok),
        dark_image_unavailable,
        supports_themed_images: true,
        supported_glyphs: WORKSPACE_ICON_GLYPHS
            .iter()
            .map(|glyph| (*glyph).into())
            .collect(),
    })
}

impl WorkspaceService {
    pub async fn get_workspace_icon(
        &self,
        workspace_id: &str,
    ) -> Result<WorkspaceIconSnapshot, String> {
        let (owner, icon) = {
            let manager = self.manager.read().await;
            let owner = icon_owner(&manager, workspace_id)?;
            let icon = icon_record(&manager.get_workspaces()[&owner])?;
            (owner, icon)
        };
        snapshot(
            self.persistence.base_dir().join("workspace-icons"),
            owner,
            icon,
        )
        .await
    }

    pub async fn set_workspace_icon(
        &self,
        request: SetWorkspaceIconRequest,
    ) -> Result<WorkspaceIconSnapshot, String> {
        if request.request_id.is_empty() || request.request_id.len() > 128 {
            return Err("Invalid workspace icon request ID".into());
        }
        // Validate authority before processing user bytes, including on SSH-backed catalogs.
        {
            let manager = self.manager.read().await;
            icon_owner(&manager, &request.workspace_id)?;
        }
        let manager = self.manager.clone();
        let persistence = self.persistence.clone();
        // An accepted write finishes even if the controller disconnects or drops its future.
        tokio::spawn(async move {
            let root = persistence.base_dir().join("workspace-icons");
            let (asset, dark_asset) = match &request.icon {
                WorkspaceIconInput::Image {
                    data_base64,
                    dark_data_base64,
                    ..
                } => {
                    let root = root.clone();
                    let light = data_base64.clone();
                    let dark = dark_data_base64.clone();
                    tokio::task::spawn_blocking(move || {
                        // Validate both before storing either variant; metadata commits atomically below.
                        let light = light.as_deref().map(normalize_icon).transpose()?;
                        let dark = dark.as_deref().map(normalize_icon).transpose()?;
                        Ok::<_, String>((
                            light
                                .as_deref()
                                .map(|bytes| store_icon(&root, bytes))
                                .transpose()?,
                            dark.as_deref()
                                .map(|bytes| store_icon(&root, bytes))
                                .transpose()?,
                        ))
                    })
                    .await
                    .map_err(|e| e.to_string())??
                }
                _ => (None, None),
            };
            let mut manager = manager.write().await;
            let owner = icon_owner(&manager, &request.workspace_id)?;
            let mut icon = icon_record(&manager.get_workspaces()[&owner])?;
            if icon.last_request_id.as_deref() == Some(&request.request_id) {
                drop(manager);
                return snapshot(root, owner, icon).await;
            }
            if icon.revision != request.expected_revision {
                return Err(
                    "Workspace icon changed on another device; reopen the editor and try again"
                        .into(),
                );
            }
            match request.icon {
                WorkspaceIconInput::Reset => {
                    icon.mode = WorkspaceIconMode::Default;
                    icon.color = "default".into();
                    icon.glyph = None;
                    icon.asset_id = None;
                    icon.dark_asset_id = None;
                }
                WorkspaceIconInput::Default { color, glyph } => {
                    if let Some(glyph) = glyph {
                        if !WORKSPACE_ICON_GLYPHS.contains(&glyph.as_str()) {
                            return Err("Unsupported workspace icon glyph".into());
                        }
                        icon.glyph = (glyph != "default").then_some(glyph);
                    }
                    icon.mode = WorkspaceIconMode::Default;
                    icon.color = color;
                    icon.asset_id = None;
                    icon.dark_asset_id = None;
                }
                WorkspaceIconInput::Image { color, .. } => {
                    icon.mode = WorkspaceIconMode::Image;
                    icon.color = color;
                    // A dark-first upload also supplies a usable image to legacy readers.
                    icon.asset_id = asset.or(icon.asset_id).or_else(|| dark_asset.clone());
                    icon.dark_asset_id = dark_asset.or(icon.dark_asset_id);
                    if icon.asset_id.is_none() {
                        return Err("Choose a workspace icon image first".into());
                    }
                }
            }
            if !valid_workspace_icon_color(&icon.color) {
                return Err("Invalid workspace icon color".into());
            }
            icon.revision = icon
                .revision
                .checked_add(1)
                .ok_or("Workspace icon revision exhausted")?;
            icon.last_request_id = Some(request.request_id);
            let mut workspaces = manager.get_workspaces().clone();
            workspaces
                .get_mut(&owner)
                .ok_or("Workspace not found")?
                .metadata
                .insert(
                    WORKSPACE_ICON_METADATA_KEY.into(),
                    serde_json::to_value(&icon).map_err(|e| e.to_string())?,
                );
            let data = WorkspacePersistenceData {
                format_version: WORKSPACE_PERSISTENCE_FORMAT_VERSION,
                product_id: product_id().to_string(),
                workspaces,
                opened_workspace_ids: manager.get_opened_workspace_ids().clone(),
                current_workspace_id: manager.get_current_workspace().map(|w| w.id.clone()),
                recent_workspaces: manager.get_recent_workspaces().clone(),
                recent_assistant_workspaces: manager.get_recent_assistant_workspaces().clone(),
                primary_assistant_key: manager.get_primary_assistant_key().cloned(),
                assistant_name_sequence: manager.assistant_name_sequence,
                saved_at: chrono::Utc::now(),
            };
            // Commit first. A disk failure leaves both the live record and lastAccessed unchanged.
            persistence
                .save_json("workspace_data", &data, StorageOptions::default())
                .await
                .map_err(|e| e.to_string())?;
            manager
                .get_workspaces_mut()
                .get_mut(&owner)
                .ok_or("Workspace not found")?
                .metadata = data.workspaces[&owner].metadata.clone();
            workspace_catalog_revision()
                .send_modify(|revision| *revision = revision.wrapping_add(1));
            drop(manager);
            snapshot(root, owner, icon).await
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str, kind: &str) -> WorkspaceInfo {
        serde_json::from_value(serde_json::json!({
            "id": id, "name": id, "rootPath": "/offline/project", "workspaceType": "Other",
            "workspaceKind": kind, "status": "Inactive", "languages": [],
            "openedAt": "2026-01-01T00:00:00Z", "lastAccessed": "2026-01-01T00:00:00Z",
            "description": null, "tags": [], "statistics": null, "metadata": {"legacy": {"preserved": true}}
        })).unwrap()
    }
    fn request(
        id: &str,
        revision: u64,
        request_id: &str,
        icon: WorkspaceIconInput,
    ) -> SetWorkspaceIconRequest {
        SetWorkspaceIconRequest {
            workspace_id: id.into(),
            expected_revision: revision,
            request_id: request_id.into(),
            icon,
        }
    }
    #[tokio::test]
    async fn legacy_records_remote_workspaces_conflicts_and_reset_survive_reload() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        let legacy = record("project", "remote");
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .insert(legacy.id.clone(), legacy.clone());
        let initial = service.get_workspace_icon("project").await.unwrap();
        assert_eq!(initial.icon, WorkspaceIcon::default());
        let change = request(
            "project",
            0,
            "first",
            WorkspaceIconInput::Default {
                color: "blue".into(),
                glyph: Some("learning".into()),
            },
        );
        let updated = service.set_workspace_icon(change.clone()).await.unwrap();
        assert_eq!(updated.icon.revision, 1);
        assert_eq!(updated.icon.glyph.as_deref(), Some("learning"));
        assert!(updated
            .supported_glyphs
            .iter()
            .any(|glyph| glyph == "learning"));
        assert_eq!(
            service.set_workspace_icon(change).await.unwrap().icon,
            updated.icon,
            "retries are idempotent"
        );
        assert!(service
            .set_workspace_icon(request(
                "project",
                0,
                "other-controller",
                WorkspaceIconInput::Reset
            ))
            .await
            .is_err());
        let stored = service
            .persistence
            .load_json::<WorkspacePersistenceData>("workspace_data")
            .await
            .unwrap()
            .unwrap();
        let raw = serde_json::to_value(&stored).unwrap();
        // The old workspace schema carries arbitrary metadata through a read/write round trip.
        let roundtrip: WorkspacePersistenceData = serde_json::from_value(raw).unwrap();
        assert_eq!(
            roundtrip.workspaces["project"].metadata["legacy"],
            legacy.metadata["legacy"]
        );
        assert_eq!(
            roundtrip.workspaces["project"].last_accessed,
            legacy.last_accessed
        );
        let restored = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        restored
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .extend(roundtrip.workspaces);
        assert_eq!(
            restored
                .get_workspace_icon("project")
                .await
                .unwrap()
                .icon
                .color,
            "blue"
        );
        let reset = restored
            .set_workspace_icon(request("project", 1, "reset", WorkspaceIconInput::Reset))
            .await
            .unwrap();
        assert_eq!(reset.icon.color, "default");
        assert!(reset.icon.glyph.is_none());
        assert_eq!(reset.icon.revision, 2);
    }
    #[tokio::test]
    async fn unknown_configuration_and_failed_disk_writes_preserve_live_records() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        let mut workspace = record("project", "normal");
        let mut future = serde_json::to_value(WorkspaceIcon::default()).unwrap();
        future["version"] = 9.into();
        workspace
            .metadata
            .insert(WORKSPACE_ICON_METADATA_KEY.into(), future.clone());
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .insert(workspace.id.clone(), workspace);
        assert!(service.get_workspace_icon("project").await.is_err());
        assert!(service
            .set_workspace_icon(request("project", 0, "reset", WorkspaceIconInput::Reset))
            .await
            .is_err());
        assert_eq!(
            service.manager.read().await.get_workspaces()["project"].metadata
                [WORKSPACE_ICON_METADATA_KEY],
            future
        );
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .get_mut("project")
            .unwrap()
            .metadata
            .remove(WORKSPACE_ICON_METADATA_KEY);
        std::fs::create_dir(
            service
                .persistence
                .base_dir()
                .join("workspace_data.json.tmp"),
        )
        .unwrap();
        assert!(service
            .set_workspace_icon(request(
                "project",
                0,
                "save",
                WorkspaceIconInput::Default {
                    color: "pink".into(),
                    glyph: None,
                }
            ))
            .await
            .is_err());
        assert_eq!(
            service
                .get_workspace_icon("project")
                .await
                .unwrap()
                .icon
                .revision,
            0
        );
    }
    #[tokio::test]
    async fn image_bytes_persist_on_catalog_host_and_missing_assets_keep_metadata() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .insert("remote".into(), record("remote", "remote"));
        let image = service.set_workspace_icon(request("remote", 0, "upload", WorkspaceIconInput::Image {
            dark_data_base64: None, color: "purple".into(), data_base64: Some("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMQUDD4DwACBAFgjby7cQAAAABJRU5ErkJggg==".into()),
        })).await.unwrap();
        assert!(image
            .image_data
            .as_deref()
            .unwrap()
            .starts_with("data:image/png;base64,"));
        assert!(!image.image_unavailable);
        let asset_id = image.icon.asset_id.as_deref().unwrap();
        assert!(valid_asset_id(asset_id));
        // No remote workspace connection or controller path is needed to read the copy.
        assert_eq!(service.get_workspace_icon("remote").await.unwrap(), image);
        std::fs::remove_file(
            service
                .persistence
                .base_dir()
                .join("workspace-icons")
                .join(format!("{asset_id}.png")),
        )
        .unwrap();
        let missing = service.get_workspace_icon("remote").await.unwrap();
        assert!(missing.image_unavailable);
        assert!(missing.image_data.is_none());
        assert_eq!(missing.icon, image.icon);
        let reset = service
            .set_workspace_icon(request("remote", 1, "reset", WorkspaceIconInput::Reset))
            .await
            .unwrap();
        assert_eq!(reset.icon.mode, WorkspaceIconMode::Default);
        assert!(reset.icon.asset_id.is_none());
        assert!(!reset.image_unavailable);
    }

    #[tokio::test]
    async fn themed_images_persist_atomically_preserve_legacy_edits_and_recover_missing_variants() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .insert("remote".into(), record("remote", "remote"));
        let input = |value| serde_json::from_value::<WorkspaceIconInput>(value).unwrap();
        let uploaded = service.set_workspace_icon(request("remote", 0, "pair", input(serde_json::json!({
            "kind": "image", "color": "default", "dataBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "darkDataBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg=="
        })))).await.unwrap();
        assert!(uploaded.supports_themed_images);
        assert_ne!(uploaded.icon.asset_id, uploaded.icon.dark_asset_id);
        assert!(uploaded.image_data.is_some() && uploaded.dark_image_data.is_some());
        let saved: WorkspacePersistenceData = service
            .persistence
            .load_json("workspace_data")
            .await
            .unwrap()
            .unwrap();
        let disk: WorkspaceIcon = serde_json::from_value(
            saved.workspaces["remote"].metadata[WORKSPACE_ICON_METADATA_KEY].clone(),
        )
        .unwrap();
        assert_eq!(disk, uploaded.icon);
        assert!(service.set_workspace_icon(request("remote", 1, "bad-pair", input(serde_json::json!({
            "kind": "image", "color": "default", "dataBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==", "darkDataBase64": "invalid"
        })))).await.is_err());
        assert_eq!(
            service.get_workspace_icon("remote").await.unwrap(),
            uploaded
        );
        // Old controllers omit darkDataBase64; a color-only image edit must retain both references.
        let legacy = service
            .set_workspace_icon(request(
                "remote",
                1,
                "legacy",
                input(serde_json::json!({
                    "kind": "image", "color": "green"
                })),
            ))
            .await
            .unwrap();
        assert_eq!(legacy.icon.dark_asset_id, uploaded.icon.dark_asset_id);
        assert_eq!(legacy.image_data, uploaded.image_data);
        assert_eq!(legacy.dark_image_data, uploaded.dark_image_data);
        std::fs::remove_file(
            service
                .persistence
                .base_dir()
                .join("workspace-icons")
                .join(format!(
                    "{}.png",
                    legacy.icon.dark_asset_id.as_deref().unwrap()
                )),
        )
        .unwrap();
        let missing = service.get_workspace_icon("remote").await.unwrap();
        assert!(missing.dark_image_unavailable && missing.dark_image_data.is_none());
        assert_eq!(missing.icon, legacy.icon);
        assert_eq!(missing.image_data, legacy.image_data);
        let reset = service
            .set_workspace_icon(request("remote", 2, "reset", WorkspaceIconInput::Reset))
            .await
            .unwrap();
        assert!(reset.icon.asset_id.is_none() && reset.icon.dark_asset_id.is_none());
        let dark_first = service.set_workspace_icon(request("remote", 3, "dark-first", input(serde_json::json!({
            "kind": "image", "color": "default", "darkDataBase64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPj/HwADAgH/5ncLrgAAAABJRU5ErkJggg=="
        })))).await.unwrap();
        assert_eq!(dark_first.icon.asset_id, dark_first.icon.dark_asset_id);
        assert_eq!(dark_first.image_data, dark_first.dark_image_data);
    }

    #[tokio::test]
    async fn worktrees_inherit_main_project_icons_without_path_or_connection_access() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        let main = record("main", "normal");
        let mut tree = record("tree", "normal");
        tree.worktree = Some(WorkspaceWorktreeInfo {
            main_workspace_id: Some("main".into()),
            path: "/offline/tree".into(),
            branch: Some("feature".into()),
            main_repo_path: "/offline/project".into(),
            is_main: false,
        });
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .extend([("main".into(), main), ("tree".into(), tree)]);
        service
            .set_workspace_icon(request(
                "tree",
                0,
                "tree-edit",
                WorkspaceIconInput::Default {
                    color: "#123abc".into(),
                    glyph: Some("design".into()),
                },
            ))
            .await
            .unwrap();
        let icon = service.get_workspace_icon("tree").await.unwrap();
        assert_eq!(icon.workspace_id, "main");
        assert_eq!(icon.icon.color, "#123abc");
        assert_eq!(icon.icon.glyph.as_deref(), Some("design"));
        assert!(!service.manager.read().await.get_workspaces()["tree"]
            .metadata
            .contains_key(WORKSPACE_ICON_METADATA_KEY));
    }
    #[tokio::test]
    async fn legacy_color_edits_preserve_glyphs_and_unknown_requests_do_not_write() {
        let root = tempfile::tempdir().unwrap();
        let service = WorkspaceService::new_isolated_for_tests(root.path().to_path_buf()).await;
        service
            .manager
            .write()
            .await
            .get_workspaces_mut()
            .insert("project".into(), record("project", "normal"));
        service
            .set_workspace_icon(request(
                "project",
                0,
                "glyph",
                WorkspaceIconInput::Default {
                    color: "blue".into(),
                    glyph: Some("travel".into()),
                },
            ))
            .await
            .unwrap();
        let legacy =
            serde_json::from_value(serde_json::json!({"kind": "default", "color": "green"}))
                .unwrap();
        let updated = service
            .set_workspace_icon(request("project", 1, "legacy", legacy))
            .await
            .unwrap();
        assert_eq!(updated.icon.glyph.as_deref(), Some("travel"));
        assert!(service
            .set_workspace_icon(request(
                "project",
                2,
                "unknown",
                WorkspaceIconInput::Default {
                    color: "red".into(),
                    glyph: Some("not-advertised".into()),
                }
            ))
            .await
            .is_err());
        assert_eq!(
            service.get_workspace_icon("project").await.unwrap(),
            updated
        );
        let saved: WorkspacePersistenceData = service
            .persistence
            .load_json("workspace_data")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            saved.workspaces["project"].metadata[WORKSPACE_ICON_METADATA_KEY]["glyph"],
            "travel"
        );
    }
}
