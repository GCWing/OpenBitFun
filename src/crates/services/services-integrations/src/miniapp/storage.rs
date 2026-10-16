//! MiniApp storage - persist and load MiniApp data under user data dir.

use openbitfun_product_domains::miniapp::customization::MiniAppCustomizationMetadata;
use openbitfun_product_domains::miniapp::ports::{
    MiniAppPortError, MiniAppPortErrorKind, MiniAppPortFuture, MiniAppStoragePort,
};
use openbitfun_product_domains::miniapp::storage::{
    build_package_json, parse_npm_dependencies, MiniAppImportBundleWriteRequest,
    MiniAppImportLayout, MiniAppStorageLayout, COMPILED_HTML, CUSTOMIZATION_JSON,
    DRAFTS_CLEANUP_MARKER, DRAFTS_CLEANUP_PREFIX, DRAFTS_DIR, DRAFT_JSON, ESM_DEPS_JSON,
    INDEX_HTML, META_JSON, PACKAGE_JSON, REQUIRED_SOURCE_FILES, STORAGE_JSON, STYLE_CSS, UI_JS,
    VERSIONS_DIR, WORKER_JS,
};
use openbitfun_product_domains::miniapp::types::{MiniApp, MiniAppMeta, MiniAppSource, NpmDep};
use openbitfun_services_core::json_store::JsonFileStore;
use serde_json;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Shared by manager storage and the Worker framework bridge. A malformed file
/// is an error, never an empty replacement. The legacy object format is retained.
pub(crate) async fn read_storage_file(path: &Path) -> MiniAppStorageResult<serde_json::Value> {
    let value: serde_json::Map<String, serde_json::Value> = JsonFileStore
        .read_optional(path)
        .await
        .map_err(|error| {
            if error.is_deserialization() {
                MiniAppStorageError::parse(error)
            } else {
                MiniAppStorageError::io(error)
            }
        })?
        .unwrap_or_default();
    Ok(serde_json::Value::Object(value))
}

pub(crate) async fn update_storage_file(
    path: &Path,
    key: &str,
    value: serde_json::Value,
) -> MiniAppStorageResult<()> {
    JsonFileStore
        .update_locked(
            path,
            serde_json::Map::<String, serde_json::Value>::new(),
            |object| {
                object.insert(key.to_string(), value);
            },
        )
        .await
        .map_err(|error| {
            if error.is_deserialization() {
                MiniAppStorageError::parse(error)
            } else {
                MiniAppStorageError::io(error)
            }
        })?;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MiniAppStorageErrorKind {
    NotFound,
    Validation,
    Deserialization,
    Io,
    Backend,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MiniAppStorageError {
    kind: MiniAppStorageErrorKind,
    message: String,
}

impl MiniAppStorageError {
    pub fn new(kind: MiniAppStorageErrorKind, message: impl ToString) -> Self {
        Self {
            kind,
            message: message.to_string(),
        }
    }

    pub fn not_found(message: impl ToString) -> Self {
        Self::new(MiniAppStorageErrorKind::NotFound, message)
    }

    pub fn validation(message: impl ToString) -> Self {
        Self::new(MiniAppStorageErrorKind::Validation, message)
    }

    pub fn parse(message: impl ToString) -> Self {
        Self::new(MiniAppStorageErrorKind::Deserialization, message)
    }

    pub fn io(message: impl ToString) -> Self {
        Self::new(MiniAppStorageErrorKind::Io, message)
    }

    pub fn kind(&self) -> MiniAppStorageErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl std::fmt::Display for MiniAppStorageError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for MiniAppStorageError {}

pub type MiniAppStorageResult<T> = Result<T, MiniAppStorageError>;

/// MiniApp storage service (file-based under the MiniApp data directory).
pub struct MiniAppStorage {
    miniapps_dir: PathBuf,
}

impl MiniAppStorage {
    pub fn new(miniapps_dir: PathBuf) -> Self {
        Self { miniapps_dir }
    }

    fn layout(&self, app_id: &str) -> MiniAppStorageLayout {
        MiniAppStorageLayout::new(&self.miniapps_dir, app_id)
    }

    fn app_dir(&self, app_id: &str) -> PathBuf {
        self.layout(app_id).app_dir()
    }

    fn meta_path(&self, app_id: &str) -> PathBuf {
        self.layout(app_id).meta_path()
    }

    fn source_dir(&self, app_id: &str) -> PathBuf {
        self.layout(app_id).source_dir()
    }

    fn compiled_path(&self, app_id: &str) -> PathBuf {
        self.layout(app_id).compiled_path()
    }

    fn storage_path(&self, app_id: &str) -> PathBuf {
        self.layout(app_id).storage_path()
    }

    fn version_path(&self, app_id: &str, version: u32) -> PathBuf {
        self.layout(app_id).version_path(version)
    }

    pub fn drafts_root(&self) -> PathBuf {
        MiniAppStorageLayout::drafts_root(&self.miniapps_dir)
    }

    pub fn app_drafts_dir(&self, app_id: &str) -> PathBuf {
        MiniAppStorageLayout::app_drafts_dir(&self.miniapps_dir, app_id)
    }

    pub fn draft_dir(&self, app_id: &str, draft_id: &str) -> PathBuf {
        MiniAppStorageLayout::draft_dir(&self.miniapps_dir, app_id, draft_id)
    }

    fn cleanup_drafts_root(&self) -> PathBuf {
        MiniAppStorageLayout::cleanup_drafts_root(
            &self.miniapps_dir,
            &uuid::Uuid::new_v4().to_string(),
        )
    }

    fn cleanup_marker_path(&self, drafts_root: &Path) -> PathBuf {
        drafts_root.join(DRAFTS_CLEANUP_MARKER)
    }

    fn draft_not_found(app_id: &str, draft_id: &str) -> MiniAppStorageError {
        MiniAppStorageError::not_found(format!("MiniApp draft not found: {}/{}", app_id, draft_id))
    }

    fn ensure_active_drafts_root_readable(
        &self,
        app_id: &str,
        draft_id: &str,
    ) -> MiniAppStorageResult<()> {
        if self.cleanup_marker_path(&self.drafts_root()).exists() {
            return Err(Self::draft_not_found(app_id, draft_id));
        }
        Ok(())
    }

    fn draft_source_dir(&self, app_id: &str, draft_id: &str) -> PathBuf {
        MiniAppStorageLayout::draft_source_dir(&self.miniapps_dir, app_id, draft_id)
    }

    fn customization_path(&self, app_id: &str) -> PathBuf {
        self.layout(app_id).customization_path()
    }

    fn validate_import_layout(
        source_path: &Path,
        import_layout: &MiniAppImportLayout,
    ) -> MiniAppStorageResult<()> {
        if !source_path.is_dir() {
            return Err(MiniAppStorageError::validation(format!(
                "Not a directory: {}",
                source_path.display()
            )));
        }

        let meta_path = import_layout.meta_path();
        let source_dir = import_layout.source_dir();
        if !meta_path.exists() {
            return Err(MiniAppStorageError::validation(format!(
                "Missing meta.json in {}",
                source_path.display()
            )));
        }
        if !source_dir.is_dir() {
            return Err(MiniAppStorageError::validation(format!(
                "Missing source/ directory in {}",
                source_path.display()
            )));
        }
        for (required, path) in import_layout.required_source_file_paths() {
            if !path.exists() {
                return Err(MiniAppStorageError::validation(format!(
                    "Missing source/{} in {}",
                    required,
                    source_path.display()
                )));
            }
        }
        Ok(())
    }

    pub async fn read_import_meta_json(
        &self,
        source_path: impl AsRef<Path>,
    ) -> MiniAppStorageResult<String> {
        let source_path = source_path.as_ref();
        let import_layout = MiniAppImportLayout::new(source_path);
        Self::validate_import_layout(source_path, &import_layout)?;
        tokio::fs::read_to_string(import_layout.meta_path())
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read meta.json: {}", e)))
    }

    pub async fn write_import_bundle(
        &self,
        request: MiniAppImportBundleWriteRequest,
    ) -> MiniAppStorageResult<()> {
        let import_layout = MiniAppImportLayout::new(&request.source_path);
        Self::validate_import_layout(&request.source_path, &import_layout)?;

        let dest_dir = self.app_dir(&request.app_id);
        let dest_source = self.source_dir(&request.app_id);
        tokio::fs::create_dir_all(&dest_source)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to create app dir: {}", e)))?;

        tokio::fs::write(dest_dir.join(META_JSON), request.meta_json)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write meta.json: {}", e)))?;

        let source_dir = import_layout.source_dir();
        for name in REQUIRED_SOURCE_FILES {
            let from = source_dir.join(name);
            let to = dest_source.join(name);
            if from.exists() {
                tokio::fs::copy(&from, &to).await.map_err(|e| {
                    MiniAppStorageError::io(format!("Failed to copy {}: {}", name, e))
                })?;
            }
        }

        let esm_path = import_layout.esm_dependencies_path();
        if esm_path.exists() {
            tokio::fs::copy(&esm_path, dest_source.join(ESM_DEPS_JSON))
                .await
                .map_err(|e| {
                    MiniAppStorageError::io(format!("Failed to copy esm_dependencies.json: {}", e))
                })?;
        } else {
            tokio::fs::write(
                dest_source.join(ESM_DEPS_JSON),
                request.esm_dependencies_json,
            )
            .await
            .map_err(|_| MiniAppStorageError::io("Failed to write esm_dependencies.json"))?;
        }

        let pkg_src = import_layout.package_json_path();
        if pkg_src.exists() {
            tokio::fs::copy(&pkg_src, dest_dir.join(PACKAGE_JSON))
                .await
                .map_err(|e| {
                    MiniAppStorageError::io(format!("Failed to copy package.json: {}", e))
                })?;
        } else {
            tokio::fs::write(dest_dir.join(PACKAGE_JSON), request.package_json)
                .await
                .map_err(|_| MiniAppStorageError::io("Failed to write package.json"))?;
        }

        let storage_src = import_layout.storage_json_path();
        if storage_src.exists() {
            tokio::fs::copy(&storage_src, dest_dir.join(STORAGE_JSON))
                .await
                .map_err(|e| {
                    MiniAppStorageError::io(format!("Failed to copy storage.json: {}", e))
                })?;
        } else {
            tokio::fs::write(dest_dir.join(STORAGE_JSON), request.storage_json)
                .await
                .map_err(|_| MiniAppStorageError::io("Failed to write storage.json"))?;
        }

        tokio::fs::write(dest_dir.join(COMPILED_HTML), request.compiled_html)
            .await
            .map_err(|_| MiniAppStorageError::io("Failed to write placeholder compiled.html"))?;
        Ok(())
    }

    /// Write a validated import bundle from an offline owner such as the data migrator.
    ///
    /// Callers must provide an isolated destination root. Product runtime code should
    /// continue using the async port; this synchronous entrypoint exists so an offline
    /// process does not need to construct the normal MiniApp runtime.
    pub fn write_import_bundle_offline(
        &self,
        request: MiniAppImportBundleWriteRequest,
    ) -> MiniAppStorageResult<()> {
        let import_layout = MiniAppImportLayout::new(&request.source_path);
        Self::validate_import_layout(&request.source_path, &import_layout)?;
        let destination = self.layout(&request.app_id);
        std::fs::create_dir_all(destination.source_dir()).map_err(|error| {
            MiniAppStorageError::io(format!(
                "Failed to create offline import directory: {error}"
            ))
        })?;
        std::fs::write(destination.meta_path(), request.meta_json).map_err(|error| {
            MiniAppStorageError::io(format!("Failed to write meta.json: {error}"))
        })?;
        for name in REQUIRED_SOURCE_FILES {
            std::fs::copy(
                import_layout.source_file_path(name),
                destination.source_file_path(name),
            )
            .map_err(|error| {
                MiniAppStorageError::io(format!("Failed to copy source/{name}: {error}"))
            })?;
        }
        let esm_source = import_layout.esm_dependencies_path();
        if esm_source.exists() {
            std::fs::copy(&esm_source, destination.source_file_path(ESM_DEPS_JSON)).map_err(
                |error| {
                    MiniAppStorageError::io(format!(
                        "Failed to copy esm_dependencies.json: {error}"
                    ))
                },
            )?;
        } else {
            std::fs::write(
                destination.source_file_path(ESM_DEPS_JSON),
                request.esm_dependencies_json,
            )
            .map_err(|error| {
                MiniAppStorageError::io(format!("Failed to write esm_dependencies.json: {error}"))
            })?;
        }
        let package_source = import_layout.package_json_path();
        if package_source.exists() {
            std::fs::copy(package_source, destination.package_json_path()).map_err(|error| {
                MiniAppStorageError::io(format!("Failed to copy package.json: {error}"))
            })?;
        } else {
            std::fs::write(destination.package_json_path(), request.package_json).map_err(
                |error| MiniAppStorageError::io(format!("Failed to write package.json: {error}")),
            )?;
        }
        let storage_source = import_layout.storage_json_path();
        if storage_source.exists() {
            std::fs::copy(storage_source, destination.storage_path()).map_err(|error| {
                MiniAppStorageError::io(format!("Failed to copy storage.json: {error}"))
            })?;
        } else {
            std::fs::write(destination.storage_path(), request.storage_json).map_err(|error| {
                MiniAppStorageError::io(format!("Failed to write storage.json: {error}"))
            })?;
        }
        std::fs::write(destination.compiled_path(), request.compiled_html).map_err(|error| {
            MiniAppStorageError::io(format!("Failed to write compiled.html: {error}"))
        })
    }

    /// Validate and read an import bundle without starting the MiniApp runtime.
    pub fn read_import_meta_json_offline(
        &self,
        source_path: impl AsRef<Path>,
    ) -> MiniAppStorageResult<String> {
        let source_path = source_path.as_ref();
        let import_layout = MiniAppImportLayout::new(source_path);
        Self::validate_import_layout(source_path, &import_layout)?;
        std::fs::read_to_string(import_layout.meta_path()).map_err(|error| {
            MiniAppStorageError::io(format!("Failed to read offline import meta.json: {error}"))
        })
    }

    /// Ensure app directory and source subdir exist.
    pub async fn ensure_app_dir(&self, app_id: &str) -> MiniAppStorageResult<()> {
        let dir = self.app_dir(app_id);
        let source = self.source_dir(app_id);
        tokio::fs::create_dir_all(&dir).await.map_err(|e| {
            MiniAppStorageError::io(format!(
                "Failed to create miniapp dir {}: {}",
                dir.display(),
                e
            ))
        })?;
        tokio::fs::create_dir_all(&source).await.map_err(|e| {
            MiniAppStorageError::io(format!(
                "Failed to create source dir {}: {}",
                source.display(),
                e
            ))
        })?;
        Ok(())
    }

    /// List all app IDs (directories under miniapps_dir).
    pub async fn list_app_ids(&self) -> MiniAppStorageResult<Vec<String>> {
        let root = &self.miniapps_dir;
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut ids = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&root)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read miniapps dir: {}", e)))?;
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read miniapps entry: {}", e)))?
        {
            let path = entry.path();
            if path.is_dir() {
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if !name.starts_with('.') {
                        ids.push(name.to_string());
                    }
                }
            }
        }
        Ok(ids)
    }

    /// Load full MiniApp by id (meta + source + compiled_html).
    pub async fn load(&self, app_id: &str) -> MiniAppStorageResult<MiniApp> {
        let meta_path = self.meta_path(app_id);
        let meta_content = tokio::fs::read_to_string(&meta_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MiniAppStorageError::not_found(format!("MiniApp not found: {}", app_id))
            } else {
                MiniAppStorageError::io(format!("Failed to read meta: {}", e))
            }
        })?;
        let meta: MiniAppMeta = serde_json::from_str(&meta_content)
            .map_err(|e| MiniAppStorageError::parse(format!("Invalid meta.json: {}", e)))?;

        let source = self.load_source(app_id).await?;
        let compiled_html = self.load_compiled_html(app_id).await?;

        Ok(MiniApp {
            chrome: meta.chrome,
            id: meta.id,
            name: meta.name,
            description: meta.description,
            icon: meta.icon,
            category: meta.category,
            tags: meta.tags,
            version: meta.version,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
            source,
            compiled_html,
            permissions: meta.permissions,
            ai_context: meta.ai_context,
            runtime: meta.runtime,
            runtime_profile: meta.runtime_profile,
            i18n: meta.i18n,
        })
    }

    /// Load only metadata (for list views).
    pub async fn load_meta(&self, app_id: &str) -> MiniAppStorageResult<MiniAppMeta> {
        let meta_path = self.meta_path(app_id);
        let content = tokio::fs::read_to_string(&meta_path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MiniAppStorageError::not_found(format!("MiniApp not found: {}", app_id))
            } else {
                MiniAppStorageError::io(format!("Failed to read meta: {}", e))
            }
        })?;
        serde_json::from_str(&content)
            .map_err(|e| MiniAppStorageError::parse(format!("Invalid meta.json: {}", e)))
    }

    async fn load_source(&self, app_id: &str) -> MiniAppStorageResult<MiniAppSource> {
        self.load_source_from_dirs(self.source_dir(app_id), self.app_dir(app_id))
            .await
    }

    async fn load_source_from_dirs(
        &self,
        source_dir: PathBuf,
        package_dir: PathBuf,
    ) -> MiniAppStorageResult<MiniAppSource> {
        let sd = source_dir;
        let html = tokio::fs::read_to_string(sd.join(INDEX_HTML))
            .await
            .unwrap_or_default();
        let css = tokio::fs::read_to_string(sd.join(STYLE_CSS))
            .await
            .unwrap_or_default();
        let ui_js = tokio::fs::read_to_string(sd.join(UI_JS))
            .await
            .unwrap_or_default();
        let worker_js = tokio::fs::read_to_string(sd.join(WORKER_JS))
            .await
            .unwrap_or_default();

        let esm_dependencies = if sd.join(ESM_DEPS_JSON).exists() {
            let c = tokio::fs::read_to_string(sd.join(ESM_DEPS_JSON))
                .await
                .unwrap_or_default();
            serde_json::from_str(&c).unwrap_or_default()
        } else {
            Vec::new()
        };

        let npm_dependencies = self
            .load_npm_dependencies_from_package(package_dir.join(PACKAGE_JSON))
            .await?;

        Ok(MiniAppSource {
            html,
            css,
            ui_js,
            esm_dependencies,
            worker_js,
            npm_dependencies,
        })
    }

    /// Load only source files and package dependencies from disk.
    pub async fn load_source_only(&self, app_id: &str) -> MiniAppStorageResult<MiniAppSource> {
        self.load_source(app_id).await
    }

    async fn load_npm_dependencies_from_package(
        &self,
        p: PathBuf,
    ) -> MiniAppStorageResult<Vec<NpmDep>> {
        if !p.exists() {
            return Ok(Vec::new());
        }
        let c = tokio::fs::read_to_string(&p)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read package.json: {}", e)))?;
        parse_npm_dependencies(&c)
            .map_err(|e| MiniAppStorageError::parse(format!("Invalid package.json: {}", e)))
    }

    async fn load_compiled_html(&self, app_id: &str) -> MiniAppStorageResult<String> {
        let p = self.compiled_path(app_id);
        tokio::fs::read_to_string(&p).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MiniAppStorageError::not_found(format!("Compiled HTML not found: {}", app_id))
            } else {
                MiniAppStorageError::io(format!("Failed to read compiled.html: {}", e))
            }
        })
    }

    /// Save full MiniApp (meta, source files, compiled.html).
    pub async fn save(&self, app: &MiniApp) -> MiniAppStorageResult<()> {
        self.save_app_files(&self.app_dir(&app.id), &self.source_dir(&app.id), app)
            .await
    }

    /// Atomically install a validated marketplace app and its trusted origin
    /// metadata. The active app directory is never visible until every source
    /// file and the strict compiled document have been written successfully.
    pub async fn install_market_atomic(
        &self,
        app: &MiniApp,
        metadata: &MiniAppCustomizationMetadata,
    ) -> MiniAppStorageResult<()> {
        tokio::fs::create_dir_all(&self.miniapps_dir)
            .await
            .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
        let target = self.app_dir(&app.id);
        if target.exists() {
            return Err(MiniAppStorageError::validation(format!(
                "MiniApp already exists: {}",
                app.id
            )));
        }
        let staging = self
            .miniapps_dir
            .join(format!(".market-install-{}", uuid::Uuid::new_v4()));
        let staging_source = staging.join("source");
        let result = async {
            self.save_app_files(&staging, &staging_source, app).await?;
            write_customization_to_path(staging.join(CUSTOMIZATION_JSON), metadata).await?;
            tokio::fs::rename(&staging, &target).await.map_err(|error| {
                MiniAppStorageError::io(format!(
                    "Failed to commit marketplace MiniApp {}: {error}",
                    app.id
                ))
            })
        }
        .await;
        if result.is_err() && staging.exists() {
            let _ = tokio::fs::remove_dir_all(&staging).await;
        }
        result
    }

    /// Atomically replace a marketplace app while preserving app storage and
    /// local version history. The old directory remains a rollback target until
    /// the new directory is in place.
    pub async fn replace_market_atomic(
        &self,
        previous: &MiniApp,
        next: &MiniApp,
        metadata: &MiniAppCustomizationMetadata,
    ) -> MiniAppStorageResult<()> {
        let target = self.app_dir(&previous.id);
        if !target.is_dir() || previous.id != next.id {
            return Err(MiniAppStorageError::validation(
                "Marketplace update target is invalid.",
            ));
        }
        let staging = self
            .miniapps_dir
            .join(format!(".market-update-{}", uuid::Uuid::new_v4()));
        let backup = self
            .miniapps_dir
            .join(format!(".market-rollback-{}", uuid::Uuid::new_v4()));
        let staging_source = staging.join("source");

        let prepare = async {
            self.save_app_files(&staging, &staging_source, next).await?;
            let old_storage = target.join(STORAGE_JSON);
            if old_storage.is_file() {
                tokio::fs::copy(&old_storage, staging.join(STORAGE_JSON))
                    .await
                    .map_err(|error| {
                        MiniAppStorageError::io(format!(
                            "Failed to preserve MiniApp storage: {error}"
                        ))
                    })?;
            }
            let old_versions = target.join(VERSIONS_DIR);
            let new_versions = staging.join(VERSIONS_DIR);
            if old_versions.is_dir() {
                copy_directory_tree(&old_versions, &new_versions).await?;
            } else {
                tokio::fs::create_dir_all(&new_versions)
                    .await
                    .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
            }
            let snapshot =
                serde_json::to_string_pretty(previous).map_err(MiniAppStorageError::parse)?;
            tokio::fs::write(
                new_versions.join(format!("v{}.json", previous.version)),
                snapshot,
            )
            .await
            .map_err(|error| {
                MiniAppStorageError::io(format!(
                    "Failed to snapshot the previous MiniApp version: {error}"
                ))
            })?;
            write_customization_to_path(staging.join(CUSTOMIZATION_JSON), metadata).await
        }
        .await;
        if let Err(error) = prepare {
            if staging.exists() {
                let _ = tokio::fs::remove_dir_all(&staging).await;
            }
            return Err(error);
        }

        tokio::fs::rename(&target, &backup).await.map_err(|error| {
            MiniAppStorageError::io(format!(
                "Failed to prepare marketplace update rollback: {error}"
            ))
        })?;
        if let Err(error) = tokio::fs::rename(&staging, &target).await {
            let _ = tokio::fs::rename(&backup, &target).await;
            let _ = tokio::fs::remove_dir_all(&staging).await;
            return Err(MiniAppStorageError::io(format!(
                "Failed to commit marketplace update; the previous version was restored: {error}"
            )));
        }
        if let Err(error) = tokio::fs::remove_dir_all(&backup).await {
            log::warn!(
                "remove completed marketplace update rollback directory {} failed: {}",
                backup.display(),
                error
            );
        }
        Ok(())
    }

    async fn save_app_files(
        &self,
        app_dir: &std::path::Path,
        source_dir: &std::path::Path,
        app: &MiniApp,
    ) -> MiniAppStorageResult<()> {
        if let Some(chrome) = &app.chrome {
            chrome.validate().map_err(MiniAppStorageError::parse)?;
        }
        tokio::fs::create_dir_all(app_dir).await.map_err(|e| {
            MiniAppStorageError::io(format!(
                "Failed to create miniapp dir {}: {}",
                app_dir.display(),
                e
            ))
        })?;
        tokio::fs::create_dir_all(source_dir).await.map_err(|e| {
            MiniAppStorageError::io(format!(
                "Failed to create source dir {}: {}",
                source_dir.display(),
                e
            ))
        })?;
        let meta = MiniAppMeta::from(app);
        let meta_path = app_dir.join(META_JSON);
        let meta_json = serde_json::to_string_pretty(&meta).map_err(MiniAppStorageError::parse)?;
        tokio::fs::write(&meta_path, meta_json)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write meta: {}", e)))?;

        let sd = source_dir;
        tokio::fs::write(sd.join(INDEX_HTML), &app.source.html)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write index.html: {}", e)))?;
        tokio::fs::write(sd.join(STYLE_CSS), &app.source.css)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write style.css: {}", e)))?;
        tokio::fs::write(sd.join(UI_JS), &app.source.ui_js)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write ui.js: {}", e)))?;
        tokio::fs::write(sd.join(WORKER_JS), &app.source.worker_js)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write worker.js: {}", e)))?;

        let esm_json = serde_json::to_string_pretty(&app.source.esm_dependencies)
            .map_err(MiniAppStorageError::parse)?;
        tokio::fs::write(sd.join(ESM_DEPS_JSON), esm_json)
            .await
            .map_err(|e| {
                MiniAppStorageError::io(format!("Failed to write esm_dependencies.json: {}", e))
            })?;

        self.write_package_json_to_dir(app_dir, &app.id, &app.source.npm_dependencies)
            .await?;

        let storage_path = app_dir.join(STORAGE_JSON);
        if !storage_path.exists() {
            tokio::fs::write(&storage_path, "{}").await.map_err(|e| {
                MiniAppStorageError::io(format!("Failed to write storage.json: {}", e))
            })?;
        }

        tokio::fs::write(app_dir.join(COMPILED_HTML), &app.compiled_html)
            .await
            .map_err(|e| {
                MiniAppStorageError::io(format!("Failed to write compiled.html: {}", e))
            })?;

        Ok(())
    }

    async fn write_package_json_to_dir(
        &self,
        app_dir: &std::path::Path,
        app_id: &str,
        deps: &[NpmDep],
    ) -> MiniAppStorageResult<()> {
        let pkg = build_package_json(app_id, deps);
        let json = serde_json::to_string_pretty(&pkg).map_err(MiniAppStorageError::parse)?;
        tokio::fs::write(app_dir.join(PACKAGE_JSON), json)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write package.json: {}", e)))?;
        Ok(())
    }

    pub async fn save_draft(
        &self,
        app_id: &str,
        draft_id: &str,
        app: &MiniApp,
        manifest: &serde_json::Value,
    ) -> MiniAppStorageResult<()> {
        self.ensure_active_drafts_root_writable().await?;
        let draft_dir = self.draft_dir(app_id, draft_id);
        let source_dir = self.draft_source_dir(app_id, draft_id);
        self.save_app_files(&draft_dir, &source_dir, app).await?;
        let manifest_json =
            serde_json::to_string_pretty(manifest).map_err(MiniAppStorageError::parse)?;
        tokio::fs::write(draft_dir.join(DRAFT_JSON), manifest_json)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write draft.json: {}", e)))?;
        let storage_path = draft_dir.join(STORAGE_JSON);
        if !storage_path.exists() {
            tokio::fs::write(storage_path, "{}").await.map_err(|e| {
                MiniAppStorageError::io(format!("Failed to write draft storage: {}", e))
            })?;
        }
        Ok(())
    }

    pub async fn load_draft_app(
        &self,
        app_id: &str,
        draft_id: &str,
    ) -> MiniAppStorageResult<MiniApp> {
        self.ensure_active_drafts_root_readable(app_id, draft_id)?;
        let draft_dir = self.draft_dir(app_id, draft_id);
        let meta_content = tokio::fs::read_to_string(draft_dir.join(META_JSON))
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    Self::draft_not_found(app_id, draft_id)
                } else {
                    MiniAppStorageError::io(format!("Failed to read draft meta: {}", e))
                }
            })?;
        let meta: MiniAppMeta = serde_json::from_str(&meta_content)
            .map_err(|e| MiniAppStorageError::parse(format!("Invalid draft meta.json: {}", e)))?;
        let source = self
            .load_source_from_dirs(self.draft_source_dir(app_id, draft_id), draft_dir.clone())
            .await?;
        let compiled_html = tokio::fs::read_to_string(draft_dir.join(COMPILED_HTML))
            .await
            .map_err(|e| {
                if e.kind() == std::io::ErrorKind::NotFound {
                    MiniAppStorageError::not_found(format!(
                        "MiniApp draft compiled HTML not found: {}/{}",
                        app_id, draft_id
                    ))
                } else {
                    MiniAppStorageError::io(format!("Failed to read draft compiled.html: {}", e))
                }
            })?;
        Ok(MiniApp {
            chrome: meta.chrome,
            id: meta.id,
            name: meta.name,
            description: meta.description,
            icon: meta.icon,
            category: meta.category,
            tags: meta.tags,
            version: meta.version,
            created_at: meta.created_at,
            updated_at: meta.updated_at,
            source,
            compiled_html,
            permissions: meta.permissions,
            ai_context: meta.ai_context,
            runtime: meta.runtime,
            runtime_profile: meta.runtime_profile,
            i18n: meta.i18n,
        })
    }

    pub async fn load_draft_manifest(
        &self,
        app_id: &str,
        draft_id: &str,
    ) -> MiniAppStorageResult<serde_json::Value> {
        self.ensure_active_drafts_root_readable(app_id, draft_id)?;
        let path = self.draft_dir(app_id, draft_id).join(DRAFT_JSON);
        let content = tokio::fs::read_to_string(&path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Self::draft_not_found(app_id, draft_id)
            } else {
                MiniAppStorageError::io(format!("Failed to read draft.json: {}", e))
            }
        })?;
        serde_json::from_str(&content)
            .map_err(|e| MiniAppStorageError::parse(format!("Invalid draft.json: {}", e)))
    }

    pub async fn delete_draft(&self, app_id: &str, draft_id: &str) -> MiniAppStorageResult<()> {
        let dir = self.draft_dir(app_id, draft_id);
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await.map_err(|e| {
                MiniAppStorageError::io(format!("Failed to delete miniapp draft: {}", e))
            })?;
        }
        Ok(())
    }

    pub async fn mark_stale_drafts_for_cleanup(&self) -> MiniAppStorageResult<Vec<PathBuf>> {
        let mut targets = self.collect_marked_drafts_roots().await?;
        if let Some(target) = self.isolate_active_drafts_root().await? {
            targets.push(target);
        }
        targets.sort();
        targets.dedup();
        Ok(targets)
    }

    pub async fn cleanup_marked_drafts(&self, targets: Vec<PathBuf>) -> MiniAppStorageResult<()> {
        for target in targets {
            if !self.is_cleanup_safe_drafts_root(&target) {
                continue;
            }
            if !self.cleanup_marker_path(&target).exists() {
                continue;
            }
            if target.exists() {
                tokio::fs::remove_dir_all(&target).await.map_err(|e| {
                    MiniAppStorageError::io(format!(
                        "Failed to clean marked miniapp drafts {}: {}",
                        target.display(),
                        e
                    ))
                })?;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        Ok(())
    }

    async fn ensure_active_drafts_root_writable(&self) -> MiniAppStorageResult<()> {
        if self.cleanup_marker_path(&self.drafts_root()).exists() {
            let _ = self.isolate_active_drafts_root().await?;
        }
        Ok(())
    }

    async fn collect_marked_drafts_roots(&self) -> MiniAppStorageResult<Vec<PathBuf>> {
        let root = &self.miniapps_dir;
        if !root.exists() {
            return Ok(Vec::new());
        }
        let mut targets = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&root)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read miniapps dir: {}", e)))?;
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read miniapps entry: {}", e)))?
        {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                continue;
            };
            if name.starts_with(DRAFTS_CLEANUP_PREFIX)
                && path.is_dir()
                && self.cleanup_marker_path(&path).exists()
            {
                targets.push(path);
            }
        }
        Ok(targets)
    }

    async fn isolate_active_drafts_root(&self) -> MiniAppStorageResult<Option<PathBuf>> {
        let active = self.drafts_root();
        if !active.exists() {
            return Ok(None);
        }
        self.write_cleanup_marker(&active).await?;
        let target = self.cleanup_drafts_root();
        tokio::fs::rename(&active, &target).await.map_err(|e| {
            MiniAppStorageError::io(format!(
                "Failed to mark miniapp drafts for cleanup {} -> {}: {}",
                active.display(),
                target.display(),
                e
            ))
        })?;
        Ok(Some(target))
    }

    async fn write_cleanup_marker(&self, drafts_root: &Path) -> MiniAppStorageResult<()> {
        tokio::fs::create_dir_all(drafts_root).await.map_err(|e| {
            MiniAppStorageError::io(format!(
                "Failed to create miniapp drafts dir {}: {}",
                drafts_root.display(),
                e
            ))
        })?;
        tokio::fs::write(
            self.cleanup_marker_path(drafts_root),
            "pending miniapp draft cleanup\n",
        )
        .await
        .map_err(|e| MiniAppStorageError::io(format!("Failed to mark miniapp drafts: {}", e)))?;
        Ok(())
    }

    fn is_cleanup_safe_drafts_root(&self, path: &Path) -> bool {
        let root = &self.miniapps_dir;
        if !path.starts_with(root) {
            return false;
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            return false;
        };
        name == DRAFTS_DIR || name.starts_with(DRAFTS_CLEANUP_PREFIX)
    }

    /// Save a version snapshot (for rollback).
    pub async fn save_version(
        &self,
        app_id: &str,
        version: u32,
        app: &MiniApp,
    ) -> MiniAppStorageResult<()> {
        let versions_dir = self.layout(app_id).versions_dir();
        tokio::fs::create_dir_all(&versions_dir)
            .await
            .map_err(|e| {
                MiniAppStorageError::io(format!("Failed to create versions dir: {}", e))
            })?;
        let path = self.version_path(app_id, version);
        let json = serde_json::to_string_pretty(app).map_err(MiniAppStorageError::parse)?;
        tokio::fs::write(&path, json)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to write version file: {}", e)))?;
        Ok(())
    }

    /// Load app storage (KV JSON). Returns empty object if missing.
    pub async fn load_app_storage(&self, app_id: &str) -> MiniAppStorageResult<serde_json::Value> {
        read_storage_file(&self.storage_path(app_id)).await
    }

    pub async fn load_draft_storage(
        &self,
        app_id: &str,
        draft_id: &str,
    ) -> MiniAppStorageResult<serde_json::Value> {
        self.ensure_active_drafts_root_readable(app_id, draft_id)?;
        let p = self.draft_dir(app_id, draft_id).join(STORAGE_JSON);
        read_storage_file(&p).await
    }

    /// Save app storage (merge with existing or replace).
    pub async fn save_app_storage(
        &self,
        app_id: &str,
        key: &str,
        value: serde_json::Value,
    ) -> MiniAppStorageResult<()> {
        self.ensure_app_dir(app_id).await?;
        update_storage_file(&self.storage_path(app_id), key, value).await
    }

    pub async fn save_draft_storage(
        &self,
        app_id: &str,
        draft_id: &str,
        key: &str,
        value: serde_json::Value,
    ) -> MiniAppStorageResult<()> {
        self.ensure_active_drafts_root_writable().await?;
        let dir = self.draft_dir(app_id, draft_id);
        tokio::fs::create_dir_all(&dir)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to create draft dir: {}", e)))?;
        update_storage_file(&dir.join(STORAGE_JSON), key, value).await
    }

    pub async fn load_customization_metadata(
        &self,
        app_id: &str,
    ) -> MiniAppStorageResult<Option<MiniAppCustomizationMetadata>> {
        let path = self.customization_path(app_id);
        if !path.exists() {
            return Ok(None);
        }
        let content = tokio::fs::read_to_string(&path).await.map_err(|e| {
            MiniAppStorageError::io(format!("Failed to read customization metadata: {}", e))
        })?;
        serde_json::from_str(&content).map(Some).map_err(|e| {
            MiniAppStorageError::parse(format!("Invalid customization metadata: {}", e))
        })
    }

    pub async fn save_customization_metadata(
        &self,
        app_id: &str,
        metadata: &MiniAppCustomizationMetadata,
    ) -> MiniAppStorageResult<()> {
        self.ensure_app_dir(app_id).await?;
        let json = serde_json::to_string_pretty(metadata).map_err(MiniAppStorageError::parse)?;
        tokio::fs::write(self.customization_path(app_id), json)
            .await
            .map_err(|e| {
                MiniAppStorageError::io(format!("Failed to write customization metadata: {}", e))
            })?;
        Ok(())
    }

    /// Delete MiniApp directory entirely.
    pub async fn delete(&self, app_id: &str) -> MiniAppStorageResult<()> {
        let dir = self.app_dir(app_id);
        if dir.exists() {
            tokio::fs::remove_dir_all(&dir).await.map_err(|e| {
                MiniAppStorageError::io(format!("Failed to delete miniapp dir: {}", e))
            })?;
        }
        let drafts_dir = self.app_drafts_dir(app_id);
        if drafts_dir.exists() {
            tokio::fs::remove_dir_all(&drafts_dir).await.map_err(|e| {
                MiniAppStorageError::io(format!("Failed to delete miniapp drafts: {}", e))
            })?;
        }
        Ok(())
    }

    /// List version numbers that have snapshots.
    pub async fn list_versions(&self, app_id: &str) -> MiniAppStorageResult<Vec<u32>> {
        let vdir = self.layout(app_id).versions_dir();
        if !vdir.exists() {
            return Ok(Vec::new());
        }
        let mut versions = Vec::new();
        let mut read_dir = tokio::fs::read_dir(&vdir)
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read versions dir: {}", e)))?;
        while let Some(entry) = read_dir
            .next_entry()
            .await
            .map_err(|e| MiniAppStorageError::io(format!("Failed to read versions entry: {}", e)))?
        {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.starts_with('v') && name.ends_with(".json") {
                if let Ok(n) = name[1..name.len() - 5].parse::<u32>() {
                    versions.push(n);
                }
            }
        }
        versions.sort();
        Ok(versions)
    }

    /// Load a specific version snapshot.
    pub async fn load_version(&self, app_id: &str, version: u32) -> MiniAppStorageResult<MiniApp> {
        let p = self.version_path(app_id, version);
        let c = tokio::fs::read_to_string(&p).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                MiniAppStorageError::not_found(format!("Version v{} not found", version))
            } else {
                MiniAppStorageError::io(format!("Failed to read version: {}", e))
            }
        })?;
        serde_json::from_str(&c)
            .map_err(|e| MiniAppStorageError::parse(format!("Invalid version file: {}", e)))
    }
}

async fn write_customization_to_path(
    path: PathBuf,
    metadata: &MiniAppCustomizationMetadata,
) -> MiniAppStorageResult<()> {
    let json = serde_json::to_string_pretty(metadata).map_err(MiniAppStorageError::parse)?;
    tokio::fs::write(path, json)
        .await
        .map_err(|error| MiniAppStorageError::io(error.to_string()))
}

async fn copy_directory_tree(source: &Path, target: &Path) -> MiniAppStorageResult<()> {
    tokio::fs::create_dir_all(target)
        .await
        .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((from_dir, to_dir)) = pending.pop() {
        let mut entries = tokio::fs::read_dir(&from_dir)
            .await
            .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
        while let Some(entry) = entries
            .next_entry()
            .await
            .map_err(|error| MiniAppStorageError::io(error.to_string()))?
        {
            let file_type = entry
                .file_type()
                .await
                .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
            let destination = to_dir.join(entry.file_name());
            if file_type.is_symlink() {
                return Err(MiniAppStorageError::validation(
                    "MiniApp version history cannot contain symbolic links.",
                ));
            }
            if file_type.is_dir() {
                tokio::fs::create_dir_all(&destination)
                    .await
                    .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
                pending.push((entry.path(), destination));
            } else if file_type.is_file() {
                tokio::fs::copy(entry.path(), destination)
                    .await
                    .map_err(|error| MiniAppStorageError::io(error.to_string()))?;
            }
        }
    }
    Ok(())
}

impl MiniAppStoragePort for MiniAppStorage {
    fn list_app_ids(&self) -> MiniAppPortFuture<'_, Vec<String>> {
        Box::pin(async move { self.list_app_ids().await.map_err(map_miniapp_port_error) })
    }

    fn load(&self, app_id: String) -> MiniAppPortFuture<'_, MiniApp> {
        Box::pin(async move { self.load(&app_id).await.map_err(map_miniapp_port_error) })
    }

    fn load_meta(&self, app_id: String) -> MiniAppPortFuture<'_, MiniAppMeta> {
        Box::pin(async move {
            self.load_meta(&app_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn load_source(&self, app_id: String) -> MiniAppPortFuture<'_, MiniAppSource> {
        Box::pin(async move {
            self.load_source_only(&app_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn save(&self, app: MiniApp) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move { self.save(&app).await.map_err(map_miniapp_port_error) })
    }

    fn save_version(
        &self,
        app_id: String,
        version: u32,
        app: MiniApp,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            self.save_version(&app_id, version, &app)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn load_app_storage(&self, app_id: String) -> MiniAppPortFuture<'_, serde_json::Value> {
        Box::pin(async move {
            self.load_app_storage(&app_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn save_app_storage(
        &self,
        app_id: String,
        key: String,
        value: serde_json::Value,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            self.save_app_storage(&app_id, &key, value)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn load_draft_app(&self, app_id: String, draft_id: String) -> MiniAppPortFuture<'_, MiniApp> {
        Box::pin(async move {
            self.load_draft_app(&app_id, &draft_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn load_draft_manifest(
        &self,
        app_id: String,
        draft_id: String,
    ) -> MiniAppPortFuture<'_, serde_json::Value> {
        Box::pin(async move {
            self.load_draft_manifest(&app_id, &draft_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn save_draft(
        &self,
        app_id: String,
        draft_id: String,
        app: MiniApp,
        manifest: serde_json::Value,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            self.save_draft(&app_id, &draft_id, &app, &manifest)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn delete_draft(&self, app_id: String, draft_id: String) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            self.delete_draft(&app_id, &draft_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn load_customization_metadata(
        &self,
        app_id: String,
    ) -> MiniAppPortFuture<'_, Option<MiniAppCustomizationMetadata>> {
        Box::pin(async move {
            self.load_customization_metadata(&app_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn save_customization_metadata(
        &self,
        app_id: String,
        metadata: MiniAppCustomizationMetadata,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            self.save_customization_metadata(&app_id, &metadata)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn install_market_atomic(
        &self,
        app: MiniApp,
        metadata: MiniAppCustomizationMetadata,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            MiniAppStorage::install_market_atomic(self, &app, &metadata)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn replace_market_atomic(
        &self,
        previous: MiniApp,
        next: MiniApp,
        metadata: MiniAppCustomizationMetadata,
    ) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move {
            MiniAppStorage::replace_market_atomic(self, &previous, &next, &metadata)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn delete(&self, app_id: String) -> MiniAppPortFuture<'_, ()> {
        Box::pin(async move { self.delete(&app_id).await.map_err(map_miniapp_port_error) })
    }

    fn list_versions(&self, app_id: String) -> MiniAppPortFuture<'_, Vec<u32>> {
        Box::pin(async move {
            self.list_versions(&app_id)
                .await
                .map_err(map_miniapp_port_error)
        })
    }

    fn load_version(&self, app_id: String, version: u32) -> MiniAppPortFuture<'_, MiniApp> {
        Box::pin(async move {
            self.load_version(&app_id, version)
                .await
                .map_err(map_miniapp_port_error)
        })
    }
}

fn map_miniapp_port_error(error: MiniAppStorageError) -> MiniAppPortError {
    let kind = match error.kind() {
        MiniAppStorageErrorKind::NotFound => MiniAppPortErrorKind::NotFound,
        MiniAppStorageErrorKind::Validation => MiniAppPortErrorKind::InvalidInput,
        MiniAppStorageErrorKind::Deserialization => MiniAppPortErrorKind::Deserialization,
        MiniAppStorageErrorKind::Io => MiniAppPortErrorKind::Io,
        MiniAppStorageErrorKind::Backend => MiniAppPortErrorKind::Backend,
    };
    MiniAppPortError::new(kind, error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use openbitfun_product_domains::miniapp::customization::{
        MiniAppCustomizationMetadata, MiniAppCustomizationOrigin, MiniAppCustomizationOriginKind,
    };
    use openbitfun_product_domains::miniapp::market::InstalledMarketOrigin;
    use std::fs;
    use std::path::{Path, PathBuf};

    struct TestTempDir {
        path: PathBuf,
    }

    impl TestTempDir {
        fn new(prefix: &str) -> Self {
            let path = std::env::temp_dir().join(format!("{}-{}", prefix, uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).expect("test root should be created");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TestTempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[tokio::test]
    async fn storage_port_adapter_preserves_existing_file_lifecycle() {
        let root = TestTempDir::new("openbitfun-miniapp-storage-port");
        let miniapps_dir = root.path().join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let port: &dyn MiniAppStoragePort = &storage;
        let app = sample_app("demo_app");

        port.save(app.clone()).await.unwrap();

        let ids = port.list_app_ids().await.unwrap();
        assert_eq!(ids, vec!["demo_app".to_string()]);

        let meta = port.load_meta("demo_app".to_string()).await.unwrap();
        assert_eq!(meta.name, "Demo");

        let source = port.load_source("demo_app".to_string()).await.unwrap();
        assert_eq!(source.ui_js, "console.log('ui');");

        let loaded = port.load("demo_app".to_string()).await.unwrap();
        assert_eq!(loaded.compiled_html, "<html></html>");

        port.save_app_storage(
            "demo_app".to_string(),
            "answer".to_string(),
            serde_json::json!(42),
        )
        .await
        .unwrap();
        let app_storage = port.load_app_storage("demo_app".to_string()).await.unwrap();
        assert_eq!(app_storage["answer"], 42);

        port.save_version("demo_app".to_string(), 1, app)
            .await
            .unwrap();
        assert_eq!(
            port.list_versions("demo_app".to_string()).await.unwrap(),
            vec![1]
        );
        assert_eq!(
            port.load_version("demo_app".to_string(), 1)
                .await
                .unwrap()
                .id,
            "demo_app"
        );

        port.delete("demo_app".to_string()).await.unwrap();
        assert!(port.list_app_ids().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn concurrent_storage_owners_merge_keys_and_preserve_legacy_json() {
        let root = TestTempDir::new("openbitfun-miniapp-storage-concurrency");
        let path = root.path().join("storage.json");
        fs::write(&path, r#"{"legacy":{"nested":[1,true,null]}}"#).unwrap();
        let mut writes = Vec::new();
        for index in 0..24 {
            let path = path.clone();
            writes.push(tokio::spawn(async move {
                update_storage_file(&path, &format!("key-{index}"), serde_json::json!(index))
                    .await
                    .unwrap();
            }));
        }
        for task in writes {
            task.await.unwrap();
        }
        let value = read_storage_file(&path).await.unwrap();
        assert_eq!(value["legacy"], serde_json::json!({"nested":[1,true,null]}));
        assert_eq!(value.as_object().unwrap().len(), 25);
    }

    #[tokio::test]
    async fn invalid_storage_is_reported_without_overwriting_original_bytes() {
        let root = TestTempDir::new("openbitfun-miniapp-storage-corrupt");
        let path = root.path().join("storage.json");
        for source in ["{partial", "[1,2]", "null"] {
            fs::write(&path, source).unwrap();
            assert!(read_storage_file(&path).await.is_err());
            assert!(update_storage_file(&path, "new", serde_json::json!(1))
                .await
                .is_err());
            assert_eq!(fs::read_to_string(&path).unwrap(), source);
        }
    }

    #[tokio::test]
    async fn storage_adapter_uses_product_domain_layout_contract() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-layout-port-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir.clone());
        let app = sample_app("layout_app");
        let layout = MiniAppStorageLayout::new(&miniapps_dir, "layout_app");

        storage.save(&app).await.unwrap();
        assert!(layout.storage_path().is_file());
        assert_eq!(
            fs::read_to_string(layout.storage_path()).unwrap(),
            "{}".to_string()
        );
        storage
            .save_app_storage("layout_app", "answer", serde_json::json!(42))
            .await
            .unwrap();
        storage.save_version("layout_app", 7, &app).await.unwrap();

        assert!(layout.app_dir().is_dir());
        assert!(layout.meta_path().is_file());
        assert!(layout.compiled_path().is_file());
        assert!(layout.package_json_path().is_file());
        assert!(layout.source_file_path(INDEX_HTML).is_file());
        assert!(layout.source_file_path(STYLE_CSS).is_file());
        assert!(layout.source_file_path(UI_JS).is_file());
        assert!(layout.source_file_path(WORKER_JS).is_file());
        assert!(layout.source_file_path(ESM_DEPS_JSON).is_file());
        assert!(layout.version_path(7).is_file());
    }

    #[tokio::test]
    async fn import_bundle_io_preserves_copy_and_fallback_contract() {
        let root = TestTempDir::new("openbitfun-miniapp-import-bundle-io");
        let miniapps_dir = root.path().join("miniapps");
        let import_root = root.path().join("import-source");
        let import_source_dir = import_root.join("source");
        fs::create_dir_all(&import_source_dir).unwrap();

        let template_app = sample_app("template-id");
        let meta_json = serde_json::to_string_pretty(&MiniAppMeta::from(&template_app)).unwrap();
        fs::write(import_root.join(META_JSON), &meta_json).unwrap();
        fs::write(import_source_dir.join(INDEX_HTML), "<div id=\"app\"></div>").unwrap();
        fs::write(import_source_dir.join(STYLE_CSS), "body { color: blue; }").unwrap();
        fs::write(
            import_source_dir.join(UI_JS),
            "document.getElementById('app').textContent = 'imported';",
        )
        .unwrap();
        fs::write(import_source_dir.join(WORKER_JS), "").unwrap();

        let storage = MiniAppStorage::new(miniapps_dir.clone());
        let read_meta = storage.read_import_meta_json(&import_root).await.unwrap();
        assert_eq!(read_meta, meta_json);

        storage
            .write_import_bundle(MiniAppImportBundleWriteRequest {
                source_path: import_root,
                app_id: "imported-app".to_string(),
                meta_json,
                esm_dependencies_json: "[]".to_string(),
                package_json: "{\"name\":\"miniapp-imported-app\"}".to_string(),
                storage_json: "{}".to_string(),
                compiled_html: "<html>placeholder</html>".to_string(),
            })
            .await
            .unwrap();

        let layout = MiniAppStorageLayout::new(&miniapps_dir, "imported-app");
        assert_eq!(
            fs::read_to_string(layout.source_file_path(STYLE_CSS)).unwrap(),
            "body { color: blue; }"
        );
        assert_eq!(
            fs::read_to_string(layout.source_file_path(ESM_DEPS_JSON)).unwrap(),
            "[]"
        );
        assert_eq!(
            fs::read_to_string(layout.package_json_path()).unwrap(),
            "{\"name\":\"miniapp-imported-app\"}"
        );
        assert_eq!(fs::read_to_string(layout.storage_path()).unwrap(), "{}");
        assert_eq!(
            fs::read_to_string(layout.compiled_path()).unwrap(),
            "<html>placeholder</html>"
        );
    }

    #[tokio::test]
    async fn saving_app_files_preserves_existing_storage_json() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-storage-preserve-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let app = sample_app("storage_app");

        storage.save(&app).await.unwrap();
        storage
            .save_app_storage("storage_app", "answer", serde_json::json!(42))
            .await
            .unwrap();
        storage.save(&app).await.unwrap();

        assert_eq!(
            storage
                .load_app_storage("storage_app")
                .await
                .unwrap()
                .get("answer"),
            Some(&serde_json::json!(42))
        );
    }

    #[tokio::test]
    async fn draft_storage_is_hidden_and_isolated_from_active_storage() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-draft-storage-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let app = sample_app("demo_app");

        storage.save(&app).await.unwrap();
        storage
            .save_app_storage("demo_app", "answer", serde_json::json!(42))
            .await
            .unwrap();
        storage
            .save_draft_storage("demo_app", "draft_one", "answer", serde_json::json!(7))
            .await
            .unwrap();

        assert_eq!(
            storage
                .load_app_storage("demo_app")
                .await
                .unwrap()
                .get("answer"),
            Some(&serde_json::json!(42))
        );
        assert_eq!(
            storage
                .load_draft_storage("demo_app", "draft_one")
                .await
                .unwrap()
                .get("answer"),
            Some(&serde_json::json!(7))
        );
        assert_eq!(storage.list_app_ids().await.unwrap(), vec!["demo_app"]);

        let draft_dir = storage.app_drafts_dir("demo_app");
        assert!(draft_dir.exists());
        storage.delete("demo_app").await.unwrap();
        assert!(!draft_dir.exists());
    }

    #[tokio::test]
    async fn mark_stale_drafts_moves_sandboxes_off_the_active_read_path() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-stale-drafts-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let app = sample_app("demo_app");

        storage.save(&app).await.unwrap();
        storage
            .save_draft_storage("demo_app", "stale_draft", "answer", serde_json::json!(7))
            .await
            .unwrap();

        assert!(storage.drafts_root().exists());
        let cleanup_targets = storage.mark_stale_drafts_for_cleanup().await.unwrap();

        assert_eq!(cleanup_targets.len(), 1);
        assert!(cleanup_targets[0].exists());
        assert!(storage.cleanup_marker_path(&cleanup_targets[0]).exists());
        assert!(!storage.drafts_root().exists());
        assert!(storage.load("demo_app").await.is_ok());
        assert_eq!(
            storage
                .load_draft_storage("demo_app", "stale_draft")
                .await
                .unwrap(),
            serde_json::json!({})
        );
    }

    #[tokio::test]
    async fn draft_reads_skip_marked_active_root() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-marked-draft-read-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);

        storage
            .save_draft_storage("demo_app", "stale_draft", "answer", serde_json::json!(7))
            .await
            .unwrap();
        storage
            .write_cleanup_marker(&storage.drafts_root())
            .await
            .unwrap();

        let error = storage
            .load_draft_storage("demo_app", "stale_draft")
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            MiniAppStorageError {
                kind: MiniAppStorageErrorKind::NotFound,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn cleanup_marked_drafts_removes_quarantined_sandboxes_later() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-clean-marked-drafts-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);

        storage
            .save_draft_storage("demo_app", "stale_draft", "answer", serde_json::json!(7))
            .await
            .unwrap();
        let cleanup_targets = storage.mark_stale_drafts_for_cleanup().await.unwrap();
        let cleanup_root = cleanup_targets[0].clone();

        storage
            .cleanup_marked_drafts(cleanup_targets)
            .await
            .unwrap();

        assert!(!cleanup_root.exists());
        assert!(!storage.drafts_root().exists());
    }

    #[tokio::test]
    async fn saving_new_draft_isolates_marked_active_root_first() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-marked-draft-write-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);

        storage
            .save_draft_storage("demo_app", "stale_draft", "answer", serde_json::json!(7))
            .await
            .unwrap();
        storage
            .write_cleanup_marker(&storage.drafts_root())
            .await
            .unwrap();

        storage
            .save_draft_storage("demo_app", "fresh_draft", "answer", serde_json::json!(9))
            .await
            .unwrap();

        assert_eq!(
            storage
                .load_draft_storage("demo_app", "fresh_draft")
                .await
                .unwrap()
                .get("answer"),
            Some(&serde_json::json!(9))
        );
        assert!(!storage.cleanup_marker_path(&storage.drafts_root()).exists());
    }

    #[tokio::test]
    async fn customization_metadata_roundtrips() {
        let root = std::env::temp_dir().join(format!(
            "openbitfun-miniapp-customization-meta-{}",
            uuid::Uuid::new_v4()
        ));
        let miniapps_dir = root.join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let app = sample_app("builtin-demo");
        storage.save(&app).await.unwrap();

        let metadata = MiniAppCustomizationMetadata {
            origin: MiniAppCustomizationOrigin {
                kind: MiniAppCustomizationOriginKind::Builtin,
                builtin_id: Some("builtin-demo".to_string()),
                builtin_version: Some(3),
                market: None,
            },
            local_override: true,
            last_applied_draft_id: Some("draft_one".to_string()),
            available_builtin_update: None,
            declined_builtin_updates: Vec::new(),
            updated_at: 123,
        };

        storage
            .save_customization_metadata("builtin-demo", &metadata)
            .await
            .unwrap();

        assert_eq!(
            storage
                .load_customization_metadata("builtin-demo")
                .await
                .unwrap(),
            Some(metadata)
        );
    }

    #[tokio::test]
    async fn marketplace_update_preserves_storage_and_snapshots_previous_version() {
        let root = TestTempDir::new("openbitfun-miniapp-market-atomic");
        let miniapps_dir = root.path().join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let mut previous = sample_app("market-demo");
        previous.source.npm_dependencies.clear();
        previous.source.worker_js.clear();
        previous.runtime_profile =
            openbitfun_product_domains::miniapp::types::MiniAppRuntimeProfile::MarketStrict;
        let initial_metadata = market_metadata(1, "release-one");

        storage
            .install_market_atomic(&previous, &initial_metadata)
            .await
            .unwrap();
        storage
            .save_app_storage("market-demo", "answer", serde_json::json!(42))
            .await
            .unwrap();

        let mut next = previous.clone();
        next.version = 2;
        next.source.ui_js = "document.body.dataset.version = '2';".to_string();
        let next_metadata = market_metadata(2, "release-two");
        storage
            .replace_market_atomic(&previous, &next, &next_metadata)
            .await
            .unwrap();

        let loaded = storage.load("market-demo").await.unwrap();
        assert_eq!(loaded.version, 2);
        assert_eq!(
            storage
                .load_app_storage("market-demo")
                .await
                .unwrap()
                .get("answer"),
            Some(&serde_json::json!(42))
        );
        assert_eq!(storage.list_versions("market-demo").await.unwrap(), vec![1]);
        assert_eq!(
            storage
                .load_customization_metadata("market-demo")
                .await
                .unwrap(),
            Some(next_metadata)
        );
        assert!(storage
            .list_app_ids()
            .await
            .unwrap()
            .iter()
            .all(|id| !id.starts_with(".market-")));
    }

    #[tokio::test]
    async fn rejected_marketplace_update_leaves_active_app_unchanged() {
        let root = TestTempDir::new("openbitfun-miniapp-market-reject");
        let miniapps_dir = root.path().join("miniapps");
        let storage = MiniAppStorage::new(miniapps_dir);
        let previous = sample_app("market-demo");
        storage
            .install_market_atomic(&previous, &market_metadata(1, "release-one"))
            .await
            .unwrap();
        let mut mismatched = previous.clone();
        mismatched.id = "different-app".to_string();

        storage
            .replace_market_atomic(&previous, &mismatched, &market_metadata(2, "release-two"))
            .await
            .unwrap_err();

        assert_eq!(storage.load("market-demo").await.unwrap().version, 1);
        assert!(!storage.app_dir("different-app").exists());
    }

    fn market_metadata(release_number: u32, release_id: &str) -> MiniAppCustomizationMetadata {
        MiniAppCustomizationMetadata {
            origin: MiniAppCustomizationOrigin {
                kind: MiniAppCustomizationOriginKind::Market,
                builtin_id: None,
                builtin_version: None,
                market: Some(InstalledMarketOrigin {
                    listing_id: "listing-one".to_string(),
                    release_id: release_id.to_string(),
                    release_number,
                    package_sha256: format!("{release_number:064x}"),
                }),
            },
            local_override: false,
            last_applied_draft_id: None,
            available_builtin_update: None,
            declined_builtin_updates: Vec::new(),
            updated_at: i64::from(release_number),
        }
    }

    #[tokio::test]
    async fn chrome_survives_disk_draft_version_and_legacy_roundtrips() {
        let root = TestTempDir::new("openbitfun-miniapp-chrome");
        let storage = MiniAppStorage::new(root.path().join("miniapps"));
        let mut app = sample_app("chrome-app");
        storage.save(&app).await.unwrap();
        assert!(storage.load(&app.id).await.unwrap().chrome.is_none());
        app.chrome = Some(
            serde_json::from_value(
                serde_json::json!({"titlebar":{"title":"Window", "showIcon":false}}),
            )
            .unwrap(),
        );
        storage.save(&app).await.unwrap();
        storage
            .save_draft(&app.id, "draft", &app, &serde_json::json!({}))
            .await
            .unwrap();
        storage.save_version(&app.id, 1, &app).await.unwrap();
        assert_eq!(storage.load(&app.id).await.unwrap().chrome, app.chrome);
        assert_eq!(
            storage
                .load_draft_app(&app.id, "draft")
                .await
                .unwrap()
                .chrome,
            app.chrome
        );
        assert_eq!(
            storage.load_version(&app.id, 1).await.unwrap().chrome,
            app.chrome
        );
        let original = fs::read(storage.meta_path(&app.id)).unwrap();
        app.chrome.as_mut().unwrap().titlebar.surface = "invalid-css".into();
        assert!(storage.save(&app).await.is_err());
        assert_eq!(fs::read(storage.meta_path(&app.id)).unwrap(), original);
    }

    fn sample_app(id: &str) -> MiniApp {
        MiniApp {
            chrome: None,
            id: id.to_string(),
            name: "Demo".to_string(),
            description: "Demo app".to_string(),
            icon: "sparkles".to_string(),
            category: "tools".to_string(),
            tags: vec!["demo".to_string()],
            version: 1,
            created_at: 1,
            updated_at: 2,
            source: MiniAppSource {
                html: "<div id=\"app\"></div>".to_string(),
                css: "body {}".to_string(),
                ui_js: "console.log('ui');".to_string(),
                esm_dependencies: Vec::new(),
                worker_js: "export default {};".to_string(),
                npm_dependencies: vec![NpmDep {
                    name: "lodash".to_string(),
                    version: "^4.17.21".to_string(),
                }],
            },
            compiled_html: "<html></html>".to_string(),
            permissions: Default::default(),
            ai_context: None,
            runtime: Default::default(),
            runtime_profile: Default::default(),
            i18n: None,
        }
    }
}
