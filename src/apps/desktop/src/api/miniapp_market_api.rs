//! Native MiniApp marketplace adapter.
//!
//! Network and credential-vault details live in Services. This module maps the
//! shared marketplace DTOs into Tauri commands and owns the local install /
//! update transaction against the desktop MiniApp manager.

use crate::api::app_state::AppState;
use openbitfun_core::infrastructure::events::{emit_global_event, BackendEvent};
use openbitfun_core::miniapp::lifecycle::miniapp_runtime_event_payload;
use openbitfun_core::miniapp::{
    MiniApp, MiniAppCustomizationMetadata, MiniAppPermissionDiff, MiniAppPermissions, MiniAppSource,
};
use openbitfun_product_domains::miniapp::customization::diff_permissions;
use openbitfun_product_domains::miniapp::market::{
    CursorPage, InstalledMarketOrigin, MarketListingDetail, MarketListingSummary, MarketRelease,
    MarketSubmission, MarketSubmissionDraftRequest,
};
use openbitfun_product_domains::product_release::{
    supports_market_minimum_version, OPENBITFUN_INITIAL_RELEASE_VERSION,
};
use openbitfun_services_integrations::miniapp_market::{
    submit_installed_app, validate_market_package, FavoriteAggregate, MarketBrowseRequest,
    MarketClient, RatingAggregate, ValidatedMarketPackage,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager, State, Webview};
use tokio::io::AsyncWriteExt;

const MARKET_UPLOAD_PROGRESS_EVENT: &str = "miniapp-market-upload-progress";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallRequest {
    pub slug: String,
    pub release_number: u32,
    pub existing_app_id: Option<String>,
    #[serde(default)]
    pub confirm_permissions: bool,
    #[serde(default)]
    pub confirm_overwrite: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstallResult {
    pub app: MiniApp,
    pub origin: InstalledMarketOrigin,
    pub updated: bool,
    pub permission_diff: MiniAppPermissionDiff,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketInstalledStatus {
    pub app_id: String,
    pub app_version: u32,
    pub permissions: MiniAppPermissions,
    pub origin: InstalledMarketOrigin,
    pub local_override: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSetRatingRequest {
    pub slug: String,
    pub value: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSetFavoriteRequest {
    pub slug: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSlugRequest {
    pub slug: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSubmissionIdRequest {
    pub submission_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketListingIdRequest {
    pub listing_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MarketPackagePathRequest {
    pub path: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketSubmitInstalledRequest {
    pub app_id: String,
    pub draft: MarketSubmissionDraftRequest,
    pub screenshot_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarketUploadProgress {
    submission_id: Option<String>,
    phase: &'static str,
    completed: u32,
    total: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketImportPackageRequest {
    pub path: String,
    #[serde(default)]
    pub confirm_permissions: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketPackageInspection {
    pub name: String,
    pub description: String,
    pub package_sha256: String,
    pub permissions: MiniAppPermissions,
    pub permission_diff: MiniAppPermissionDiff,
}

#[tauri::command]
pub async fn miniapp_market_browse(
    request: MarketBrowseRequest,
) -> Result<CursorPage<MarketListingSummary>, String> {
    let client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    client.browse(&request).await.map_err(market_error)
}

#[tauri::command]
pub async fn miniapp_market_get_listing(
    request: MarketSlugRequest,
) -> Result<MarketListingDetail, String> {
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    client.listing(&request.slug).await.map_err(market_error)
}

#[tauri::command]
pub async fn miniapp_market_set_rating(
    request: MarketSetRatingRequest,
) -> Result<RatingAggregate, String> {
    if request.value.is_some_and(|value| !(1..=5).contains(&value)) {
        return Err("Rating must be between 1 and 5.".to_string());
    }
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    client
        .set_rating(&request.slug, request.value)
        .await
        .map_err(market_error)
}

#[tauri::command]
pub async fn miniapp_market_set_favorite(
    request: MarketSetFavoriteRequest,
) -> Result<FavoriteAggregate, String> {
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    client
        .set_favorite(&request.slug, request.enabled)
        .await
        .map_err(market_error)
}

#[tauri::command]
pub async fn miniapp_market_list_submissions() -> Result<Vec<MarketSubmission>, String> {
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    client.list_submissions().await.map_err(market_error)
}

#[tauri::command]
pub async fn miniapp_market_withdraw_submission(
    request: MarketSubmissionIdRequest,
) -> Result<MarketSubmission, String> {
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    client
        .withdraw_submission(&request.submission_id)
        .await
        .map_err(market_error)
}

#[tauri::command]
pub async fn miniapp_market_installed_status(
    state: State<'_, AppState>,
    request: MarketListingIdRequest,
) -> Result<Option<MarketInstalledStatus>, String> {
    let apps = state
        .miniapp_manager
        .list()
        .await
        .map_err(|error| error.to_string())?;
    for app in apps {
        let Some((origin, local_override)) = load_market_origin(&state, &app.id).await? else {
            continue;
        };
        if origin.listing_id == request.listing_id {
            return Ok(Some(MarketInstalledStatus {
                app_id: app.id,
                app_version: app.version,
                permissions: app.permissions,
                origin,
                local_override,
            }));
        }
    }
    Ok(None)
}

/// Marketplace origins of every installed MiniApp, keyed by local app id.
///
/// The local `MiniApp::version` counter tracks edits to the installed copy and
/// is deliberately independent from the marketplace release number, so any
/// surface that wants to name the release a user installed has to read it from
/// the origin instead of from the app itself.
#[tauri::command]
pub async fn miniapp_market_installed_origins(
    state: State<'_, AppState>,
) -> Result<HashMap<String, InstalledMarketOrigin>, String> {
    let apps = state
        .miniapp_manager
        .list()
        .await
        .map_err(|error| error.to_string())?;
    let mut origins = HashMap::new();
    for app in apps {
        if let Some((origin, _)) = load_market_origin(&state, &app.id).await? {
            origins.insert(app.id, origin);
        }
    }
    Ok(origins)
}

/// Reads an app's marketplace origin plus its local-override flag, or `None`
/// when the app did not come from the marketplace.
async fn load_market_origin(
    state: &AppState,
    app_id: &str,
) -> Result<Option<(InstalledMarketOrigin, bool)>, String> {
    let Some(metadata) = state
        .miniapp_manager
        .load_customization_metadata(app_id)
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(None);
    };
    let local_override = metadata.local_override;
    Ok(metadata
        .origin
        .market
        .map(|origin| (origin, local_override)))
}

#[tauri::command]
pub async fn miniapp_market_install(
    state: State<'_, AppState>,
    request: MarketInstallRequest,
) -> Result<MarketInstallResult, String> {
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    let detail = client.listing(&request.slug).await.map_err(market_error)?;
    let release = find_release(&detail, request.release_number)?;
    validate_minimum_openbitfun_version(&release.min_openbitfun_version)?;
    if release.yanked {
        return Err(
            "This marketplace release has been yanked and cannot be installed.".to_string(),
        );
    }

    let bytes = client
        .download_release(&detail.summary.slug, release.release_number)
        .await
        .map_err(market_error)?;
    let package = stage_downloaded_package(&bytes).await?;
    if package.sha256 != release.package_sha256 || package.size != release.package_size {
        return Err("The downloaded package does not match the reviewed release.".to_string());
    }
    if package.meta.permissions != release.permissions {
        return Err("The package permissions do not match the reviewed release.".to_string());
    }
    let origin = InstalledMarketOrigin {
        listing_id: release.listing_id.clone(),
        release_id: release.release_id.clone(),
        release_number: release.release_number,
        package_sha256: release.package_sha256.clone(),
    };
    let source = source_from_package(&package);

    let (app, updated, permission_diff) = if let Some(app_id) = request.existing_app_id {
        let previous = state
            .miniapp_manager
            .get(&app_id)
            .await
            .map_err(|error| error.to_string())?;
        let metadata = require_matching_market_origin(
            state
                .miniapp_manager
                .load_customization_metadata(&app_id)
                .await
                .map_err(|error| error.to_string())?,
            &origin.listing_id,
        )?;
        if metadata.local_override && !request.confirm_overwrite {
            return Err(
                "This MiniApp has local customizations. Confirm overwrite to create a snapshot and continue."
                    .to_string(),
            );
        }
        let diff = diff_permissions(&previous.permissions, &package.meta.permissions);
        require_permission_confirmation(&diff, request.confirm_permissions)?;
        let app = state
            .miniapp_manager
            .update_market_package(&app_id, package.meta, source, origin.clone())
            .await
            .map_err(|error| error.to_string())?;
        (app, true, diff)
    } else {
        let diff = diff_permissions(&MiniAppPermissions::default(), &package.meta.permissions);
        require_permission_confirmation(&diff, request.confirm_permissions)?;
        let app = state
            .miniapp_manager
            .install_market_package(package.meta, source, origin.clone())
            .await
            .map_err(|error| error.to_string())?;
        (app, false, diff)
    };
    let (event_name, reason) = if updated {
        ("miniapp-updated", "market-update")
    } else {
        ("miniapp-created", "market-install")
    };
    let _ = emit_global_event(BackendEvent::Custom {
        event_name: event_name.to_string(),
        payload: miniapp_runtime_event_payload(&app, reason),
    })
    .await;
    Ok(MarketInstallResult {
        app,
        origin,
        updated,
        permission_diff,
    })
}

async fn stage_downloaded_package(bytes: &[u8]) -> Result<ValidatedMarketPackage, String> {
    if bytes.len() as u64 > openbitfun_product_domains::miniapp::market::MARKET_MAX_PACKAGE_BYTES {
        return Err("The downloaded package exceeds 20 MiB.".to_string());
    }
    let temp_prefix = format!(
        "{}-miniapp-market-download-",
        openbitfun_core_types::product_identity::data_namespace()
    );
    let directory = tempfile::Builder::new()
        .prefix(&temp_prefix)
        .tempdir()
        .map_err(|error| format!("Could not create a private download directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|error| format!("Could not secure the download directory: {error}"))?;
    }
    let path = directory.path().join("package.bfminiapp");
    let mut file = tokio::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .await
        .map_err(|error| format!("Could not stage the downloaded package: {error}"))?;
    file.write_all(bytes)
        .await
        .map_err(|error| format!("Could not write the downloaded package: {error}"))?;
    file.sync_all()
        .await
        .map_err(|error| format!("Could not flush the downloaded package: {error}"))?;
    drop(file);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
            .await
            .map_err(|error| format!("Could not secure the downloaded package: {error}"))?;
    }
    read_and_validate_package_file(&path).await
}

#[tauri::command]
pub async fn miniapp_market_import_package(
    state: State<'_, AppState>,
    request: MarketImportPackageRequest,
) -> Result<MiniApp, String> {
    let path = PathBuf::from(&request.path);
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not read package metadata: {error}"))?;
    if !metadata.is_file()
        || metadata.len() > openbitfun_product_domains::miniapp::market::MARKET_MAX_PACKAGE_BYTES
    {
        return Err("The selected .bfminiapp file is invalid or exceeds 20 MiB.".to_string());
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("bfminiapp"))
    {
        return Err("Select a .bfminiapp package.".to_string());
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|error| format!("Could not read package: {error}"))?;
    let package = validate_market_package(&bytes).map_err(|error| error.to_string())?;
    let diff = diff_permissions(&MiniAppPermissions::default(), &package.meta.permissions);
    require_permission_confirmation(&diff, request.confirm_permissions)?;
    let source = source_from_package(&package);
    state
        .miniapp_manager
        .install_strict_package_import(package.meta, source)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn miniapp_market_inspect_package(
    request: MarketPackagePathRequest,
) -> Result<MarketPackageInspection, String> {
    let package = read_and_validate_package_file(Path::new(&request.path)).await?;
    let permission_diff =
        diff_permissions(&MiniAppPermissions::default(), &package.meta.permissions);
    Ok(MarketPackageInspection {
        name: package.meta.name.clone(),
        description: package.meta.description.clone(),
        package_sha256: package.sha256.clone(),
        permissions: package.meta.permissions,
        permission_diff,
    })
}

#[tauri::command]
pub async fn miniapp_market_capture_window(
    app: AppHandle,
    webview: Webview,
) -> Result<String, String> {
    let window = webview.window();
    if webview.label() != window.label() {
        return Err("Window capture requires a top-level application WebView".into());
    }
    let position = window
        .outer_position()
        .map_err(|error| format!("Could not read the OpenBitFun window position: {error}"))?;
    let size = window
        .outer_size()
        .map_err(|error| format!("Could not read the OpenBitFun window size: {error}"))?;
    if size.width < 320 || size.height < 240 {
        return Err(
            "The OpenBitFun window is too small to capture a review screenshot.".to_string(),
        );
    }

    let capture_dir = app
        .path()
        .app_cache_dir()
        .map_err(|error| format!("Could not resolve the private cache directory: {error}"))?
        .join("miniapp-market-captures");
    tokio::fs::create_dir_all(&capture_dir)
        .await
        .map_err(|error| format!("Could not create the screenshot directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        tokio::fs::set_permissions(&capture_dir, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|error| format!("Could not secure the screenshot directory: {error}"))?;
    }
    let path = capture_dir.join(format!("{}.jpg", uuid::Uuid::new_v4()));
    let output_path = path.clone();

    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let center_x = position.x.saturating_add((size.width / 2) as i32);
        let center_y = position.y.saturating_add((size.height / 2) as i32);
        let screen = screenshots::Screen::from_point(center_x, center_y)
            .map_err(|error| format!("Could not access the current display: {error}"))?;
        let relative_x = position.x.saturating_sub(screen.display_info.x);
        let relative_y = position.y.saturating_sub(screen.display_info.y);
        let captured = screen
            .capture_area(relative_x, relative_y, size.width, size.height)
            .map_err(|error| {
                format!(
                    "Window capture failed. On macOS, grant OpenBitFun Screen Recording permission: {error}"
                )
            })?;
        let (width, height) = captured.dimensions();
        let rgba = image::RgbaImage::from_raw(width, height, captured.into_raw())
            .ok_or_else(|| "The captured window had an invalid pixel buffer.".to_string())?;
        let image = image::DynamicImage::ImageRgba8(rgba);
        let resized = if width > 1600 || height > 1200 {
            image.resize(1600, 1200, image::imageops::FilterType::Lanczos3)
        } else {
            image
        };
        let file = std::fs::File::create(&output_path)
            .map_err(|error| format!("Could not create the screenshot: {error}"))?;
        let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(file, 88);
        encoder
            .encode_image(&resized)
            .map_err(|error| format!("Could not encode the screenshot: {error}"))
    })
    .await
    .map_err(|error| format!("Screenshot capture task failed: {error}"))??;

    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn miniapp_market_submit_installed(
    app: AppHandle,
    state: State<'_, AppState>,
    request: MarketSubmitInstalledRequest,
) -> Result<MarketSubmission, String> {
    let installed = state
        .miniapp_manager
        .get(&request.app_id)
        .await
        .map_err(|error| error.to_string())?;
    let mut client = MarketClient::from_environment()
        .await
        .map_err(market_error)?;
    let mut progress = |submission_id: Option<&str>, phase: &'static str, completed, total| {
        emit_upload_progress(&app, submission_id, phase, completed, total);
    };
    let submission = submit_installed_app(
        &mut client,
        &installed,
        &request.draft,
        &request.screenshot_paths,
        &mut progress,
    )
    .await
    .map_err(market_error)?;
    remove_owned_capture_files(&app, &request.screenshot_paths).await;
    Ok(submission)
}

async fn remove_owned_capture_files(app: &AppHandle, paths: &[String]) {
    let Ok(capture_dir) = app
        .path()
        .app_cache_dir()
        .map(|path| path.join("miniapp-market-captures"))
    else {
        return;
    };
    for value in paths {
        let path = PathBuf::from(value);
        if path.parent() == Some(capture_dir.as_path()) {
            if let Err(error) = tokio::fs::remove_file(&path).await {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "remove submitted MiniApp market capture {} failed: {}",
                        path.display(),
                        error
                    );
                }
            }
        }
    }
}

fn source_from_package(package: &ValidatedMarketPackage) -> MiniAppSource {
    let file = |name: &str| package.source_files.get(name).cloned().unwrap_or_default();
    MiniAppSource {
        html: file("source/index.html"),
        css: file("source/style.css"),
        ui_js: file("source/ui.js"),
        esm_dependencies: Vec::new(),
        worker_js: file("source/worker.js"),
        npm_dependencies: Vec::new(),
    }
}

async fn read_and_validate_package_file(path: &Path) -> Result<ValidatedMarketPackage, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("Could not read package metadata: {error}"))?;
    if !metadata.is_file()
        || metadata.len() > openbitfun_product_domains::miniapp::market::MARKET_MAX_PACKAGE_BYTES
    {
        return Err("The selected .bfminiapp file is invalid or exceeds 20 MiB.".to_string());
    }
    if path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_none_or(|extension| !extension.eq_ignore_ascii_case("bfminiapp"))
    {
        return Err("Select a .bfminiapp package.".to_string());
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|error| format!("Could not read package: {error}"))?;
    validate_market_package(&bytes).map_err(|error| error.to_string())
}

fn find_release(
    detail: &MarketListingDetail,
    release_number: u32,
) -> Result<MarketRelease, String> {
    detail
        .releases
        .iter()
        .find(|release| release.release_number == release_number)
        .cloned()
        .ok_or_else(|| format!("Marketplace release {release_number} was not found."))
}

fn require_matching_market_origin(
    metadata: Option<MiniAppCustomizationMetadata>,
    listing_id: &str,
) -> Result<MiniAppCustomizationMetadata, String> {
    let metadata = metadata.ok_or_else(|| "MiniApp has no marketplace origin.".to_string())?;
    if metadata
        .origin
        .market
        .as_ref()
        .is_none_or(|origin| origin.listing_id != listing_id)
    {
        return Err(
            "The installed MiniApp belongs to a different marketplace listing.".to_string(),
        );
    }
    Ok(metadata)
}

fn require_permission_confirmation(
    diff: &MiniAppPermissionDiff,
    confirmed: bool,
) -> Result<(), String> {
    if (!diff.added.is_empty() || !diff.expanded.is_empty()) && !confirmed {
        return Err(format!(
            "Permission confirmation required: {}",
            diff.added
                .iter()
                .chain(diff.expanded.iter())
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    Ok(())
}

fn validate_minimum_openbitfun_version(minimum: &str) -> Result<(), String> {
    let minimum = semver::Version::parse(minimum)
        .map_err(|_| "The release declares an invalid minimum OpenBitFun version.".to_string())?;
    if minimum < OPENBITFUN_INITIAL_RELEASE_VERSION {
        return Err(
            "The release declares a minimum OpenBitFun version earlier than 1.0.0.".to_string(),
        );
    }
    let current = semver::Version::parse(env!("CARGO_PKG_VERSION"))
        .map_err(|_| "The current OpenBitFun version is invalid.".to_string())?;
    if !supports_market_minimum_version(&current, &minimum) {
        return Err(format!(
            "This MiniApp requires OpenBitFun {minimum} or newer. Current version: {current}."
        ));
    }
    Ok(())
}

fn emit_upload_progress(
    app: &AppHandle,
    submission_id: Option<&str>,
    phase: &'static str,
    completed: u32,
    total: u32,
) {
    let _ = app.emit(
        MARKET_UPLOAD_PROGRESS_EVENT,
        MarketUploadProgress {
            submission_id: submission_id.map(str::to_string),
            phase,
            completed,
            total,
        },
    );
}

fn market_error(error: impl Serialize + std::fmt::Display) -> String {
    serde_json::to_string(&error).unwrap_or_else(|_| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::validate_minimum_openbitfun_version;

    #[test]
    fn rejects_minimum_versions_before_initial_openbitfun_release() {
        assert!(validate_minimum_openbitfun_version("1.0.0").is_ok());
        let pre_release_identity = [0, 9, 0]
            .into_iter()
            .map(|part| part.to_string())
            .collect::<Vec<_>>()
            .join(".");
        assert!(validate_minimum_openbitfun_version(&pre_release_identity).is_err());
        assert!(validate_minimum_openbitfun_version("1.0.0-rc.1").is_err());
    }
}
