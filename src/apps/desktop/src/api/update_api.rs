//! Desktop-owned staged application updates. Download never starts an installer.

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{io::Write, path::Path, sync::OnceLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterBuilder;

const PROGRESS_EVENT: &str = "openbitfun-update-progress";
const RECORD_NAME: &str = "pending.json";
const RECEIPT_NAME: &str = "install-result.json";

// Serialize downloads and installs at the host, including calls from multiple windows.
static UPDATE: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
static CANCEL_DOWNLOAD: OnceLock<std::sync::Mutex<Option<tokio::sync::oneshot::Sender<()>>>> =
    OnceLock::new();

struct DownloadCancellation;
impl Drop for DownloadCancellation {
    fn drop(&mut self) {
        if let Ok(mut sender) = CANCEL_DOWNLOAD.get_or_init(Default::default).lock() {
            sender.take();
        }
    }
}

#[tauri::command]
pub async fn cancel_app_update_download(request: PendingUpdateRequest) -> Result<(), String> {
    let _ = request;
    let sender = CANCEL_DOWNLOAD
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Download cancellation state is unavailable".to_string())?
        .take();
    if let Some(sender) = sender {
        let _ = sender.send(());
        Ok(())
    } else {
        Err("No cancellable update download is running; package finalization may already be in progress".into())
    }
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdateRequest {}

#[derive(Debug, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DownloadUpdateRequest {
    #[serde(default)]
    pub expected_version: Option<String>,
}

impl DownloadUpdateRequest {
    fn validate_version(&self, available: &str) -> Result<(), String> {
        if let Some(expected) = &self.expected_version {
            if expected != available {
                return Err(format!(
                    "Update version changed from {expected} to {available}; check for updates again"
                ));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPendingUpdateRequest {
    pub version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingUpdateResponse {
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub install_error: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingUpdateRecord {
    version: String,
    platform: String,
    signature: String,
    sha256: String,
    #[serde(default)]
    package_kind: Option<String>,
}

impl PendingUpdateRecord {
    fn response(&self) -> PendingUpdateResponse {
        PendingUpdateResponse {
            version: self.version.clone(),
            install_error: None,
        }
    }

    fn applies_to(&self, current: &semver::Version, platform: &str) -> Result<bool, String> {
        let version = semver::Version::parse(&self.version).map_err(|e| e.to_string())?;
        Ok(version > *current && self.platform == platform)
    }

    fn package_name(&self) -> Result<String, String> {
        if self.sha256.len() != 64 || !self.sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err("Invalid pending update checksum".into());
        }
        Ok(format!("{}.package", self.sha256))
    }
}

fn platform() -> String {
    format!("{}-{}", std::env::consts::OS, std::env::consts::ARCH)
}

fn package_kind() -> &'static str {
    use tauri::utils::config::BundleType;
    match tauri::utils::platform::bundle_type() {
        Some(BundleType::Deb) => "deb",
        Some(BundleType::Rpm) => "rpm",
        Some(BundleType::AppImage) => "appimage",
        Some(BundleType::App) => "app",
        Some(BundleType::Nsis) => "nsis",
        Some(BundleType::Msi) => "msi",
        _ => "unbundled",
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct InstallationReceipt {
    version: String,
    success: bool,
    #[serde(default)]
    error: Option<String>,
}

fn pending_response(
    dir: &Path,
    record: PendingUpdateRecord,
) -> Result<PendingUpdateResponse, String> {
    let mut response = record.response();
    match std::fs::read(dir.join(RECEIPT_NAME)) {
        Ok(bytes) => {
            let receipt: InstallationReceipt = serde_json::from_slice(&bytes).map_err(|e| {
                format!("Cannot read update installation result; preserved for repair: {e}")
            })?;
            // A matching pending record is offered only while the running
            // version is older. Even exit code zero must not hide that fact.
            if receipt.version == record.version {
                response.install_error = Some(receipt.error.unwrap_or_else(|| {
                    if receipt.success {
                        "The installer finished, but the running version is still older; restart or repair the installation".into()
                    } else {
                        "The previous update installation failed; retry or reinstall manually".into()
                    }
                }));
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(format!("Cannot read update installation result: {error}")),
    }
    Ok(response)
}

fn cache_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    if crate::e2e_storage_guard_enabled() {
        return Ok(openbitfun_core::infrastructure::get_path_manager_arc()
            .user_data_dir()
            .join("app-updates"));
    }
    app.path()
        .app_cache_dir()
        .map(|p| p.join("app-updates"))
        .map_err(|e| e.to_string())
}

fn read_record(
    dir: &Path,
    current: &semver::Version,
    platform: &str,
) -> Result<Option<PendingUpdateRecord>, String> {
    let bytes = match std::fs::read(dir.join(RECORD_NAME)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("Cannot read pending update: {e}")),
    };
    // Never remove an unreadable record as a recovery mechanism.
    let record: PendingUpdateRecord = serde_json::from_slice(&bytes)
        .map_err(|e| format!("Cannot read pending update metadata: {e}"))?;
    if !record.applies_to(current, platform)? {
        return Ok(None);
    }
    if record.package_kind.as_deref() != Some(package_kind()) {
        return Err("Update package belongs to another installation format or has legacy metadata; download it again".into());
    }
    let package = dir.join(record.package_name()?);
    if !package.is_file() {
        return Err("Pending update package is missing; download the update again".into());
    }
    Ok(Some(record))
}

fn atomic_write(dir: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(dir.join(name)).map_err(|e| e.to_string())?;
    Ok(())
}

fn save_package(dir: &Path, record: &PendingUpdateRecord, bytes: &[u8]) -> Result<(), String> {
    // Commit the metadata last. A partial download can never become installable.
    atomic_write(dir, &record.package_name()?, bytes)?;
    atomic_write(
        dir,
        RECORD_NAME,
        &serde_json::to_vec(record).map_err(|e| e.to_string())?,
    )
}

fn verify_package(bytes: &[u8], record: &PendingUpdateRecord, pubkey: &str) -> Result<(), String> {
    if format!("{:x}", Sha256::digest(bytes)) != record.sha256 {
        return Err(
            "Pending update signature verification failed: package checksum mismatch".into(),
        );
    }
    // The official downloader verified the original transfer. Re-verify cached
    // bytes against the bundled trust root before handing them to our adapter.
    let decode = |value: &str| -> Result<String, String> {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(value.trim())
            .map_err(|e| format!("Update signature decoding failed: {e}"))?;
        String::from_utf8(bytes).map_err(|e| format!("Update signature decoding failed: {e}"))
    };
    let public_key = minisign_verify::PublicKey::decode(&decode(pubkey)?)
        .map_err(|e| format!("Update signature public key is invalid: {e}"))?;
    let signature = minisign_verify::Signature::decode(&decode(&record.signature)?)
        .map_err(|e| format!("Update signature is invalid: {e}"))?;
    public_key
        .verify(bytes, &signature, true)
        .map_err(|e| format!("Update signature verification failed: {e}"))
}

pub(super) fn configure_updater(builder: UpdaterBuilder) -> UpdaterBuilder {
    // Public official-plugin API: bound stalls without a total download deadline.
    builder.configure_client(|client| {
        client
            .connect_timeout(std::time::Duration::from_secs(20))
            .read_timeout(std::time::Duration::from_secs(60))
    })
}

#[cfg(any(windows, test))]
pub(crate) fn windows_machine_install(directory: &Path) -> bool {
    let read = |path: &Path| {
        std::fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
    };
    read(&directory.join(".openbitfun-installed.json")).is_some_and(|value| {
        value.get("allUsers").and_then(serde_json::Value::as_bool) == Some(true)
    }) || read(&directory.join(".openbitfun-maintenance/journal.json")).is_some_and(|value| {
        value
            .pointer("/integrations/registry/machine")
            .and_then(serde_json::Value::as_bool)
            == Some(true)
    })
}

#[tauri::command]
pub async fn get_pending_update(
    app: AppHandle,
    request: PendingUpdateRequest,
) -> Result<Option<PendingUpdateResponse>, String> {
    let _ = request;
    let dir = cache_dir(&app)?;
    let current = app.package_info().version.clone();
    tokio::task::spawn_blocking(move || {
        read_record(&dir, &current, &platform())?
            .map(|r| pending_response(&dir, r))
            .transpose()
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn download_update(
    app: AppHandle,
    request: DownloadUpdateRequest,
) -> Result<PendingUpdateResponse, String> {
    let _operation = UPDATE
        .get_or_init(Default::default)
        .try_lock()
        .map_err(|_| "An update operation is already in progress".to_string())?;
    let (cancel_tx, cancel_rx) = tokio::sync::oneshot::channel();
    *CANCEL_DOWNLOAD
        .get_or_init(Default::default)
        .lock()
        .map_err(|_| "Download cancellation state is unavailable".to_string())? = Some(cancel_tx);
    let cancellation = DownloadCancellation;
    let transfer = async {
        let updater = super::system_api::ranked_updater(&app).await?;
        let update = updater
            .check()
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "No update available".to_string())?;
        request.validate_version(&update.version)?;
        let mut downloaded = 0u64;
        let bytes = update
            .download(
                |chunk, total| {
                    downloaded = downloaded.saturating_add(chunk as u64);
                    let _ = app.emit(
                        PROGRESS_EVENT,
                        serde_json::json!({ "downloaded": downloaded, "total": total }),
                    );
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;
        Ok::<_, String>((update, bytes))
    };
    let (update, bytes) = tokio::select! {
        result = transfer => result?,
        _ = cancel_rx => return Err("Update download canceled".into()),
    };
    // Finalization cannot be canceled midway through committing pending.json.
    drop(cancellation);
    let record = PendingUpdateRecord {
        version: update.version.clone(),
        platform: platform(),
        signature: update.signature.clone(),
        sha256: format!("{:x}", Sha256::digest(&bytes)),
        package_kind: Some(package_kind().into()),
    };
    let response = record.response();
    let dir = cache_dir(&app)?;
    tokio::task::spawn_blocking(move || save_package(&dir, &record, &bytes))
        .await
        .map_err(|e| e.to_string())??;
    Ok(response)
}

#[tauri::command]
pub async fn install_pending_update(
    app: AppHandle,
    request: InstallPendingUpdateRequest,
) -> Result<(), String> {
    let _operation = UPDATE
        .get_or_init(Default::default)
        .try_lock()
        .map_err(|_| "An update operation is already in progress".to_string())?;
    let dir = cache_dir(&app)?;
    let receipt = dir.join(RECEIPT_NAME);
    let current = app.package_info().version.clone();
    let pubkey = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.get("pubkey"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| "Update signature public key is unavailable".to_string())?
        .to_owned();
    let (record, bytes) = tokio::task::spawn_blocking(move || {
        let record = read_record(&dir, &current, &platform())?
            .ok_or_else(|| "No downloaded update is available".to_string())?;
        if record.version != request.version {
            return Err(
                "The downloaded update has changed; reopen About before installing".to_string(),
            );
        }
        let bytes = std::fs::read(dir.join(record.package_name()?)).map_err(|e| e.to_string())?;
        verify_package(&bytes, &record, &pubkey)?;
        Ok::<_, String>((record, bytes))
    })
    .await
    .map_err(|e| e.to_string())??;

    let maintenance_app = app.clone();
    tokio::task::spawn_blocking(move || {
        crate::update_maintenance::install(
            &maintenance_app,
            &bytes,
            &record.version,
            record.package_kind.as_deref().unwrap_or("unbundled"),
            &receipt,
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    #[cfg(windows)]
    {
        // A ready supervisor now owns the handoff. It waits for this process,
        // retains post-exit errors and restarts with the original user's token.
        crate::save_main_window_state(&app, "install_update");
        crate::perform_process_exit_cleanup().await;
        crate::crash_diagnostics::mark_clean_shutdown("install_update");
        app.cleanup_before_exit();
        std::process::exit(0);
    }
    #[cfg(not(windows))]
    super::system_api::restart_app(app, Default::default()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn machine_installs_request_elevation_even_in_writable_custom_directories() {
        let root = tempfile::tempdir().unwrap();
        assert!(!windows_machine_install(root.path()));
        std::fs::write(
            root.path().join(".openbitfun-installed.json"),
            br#"{"allUsers":true}"#,
        )
        .unwrap();
        assert!(windows_machine_install(root.path()));
        std::fs::remove_file(root.path().join(".openbitfun-installed.json")).unwrap();
        std::fs::create_dir(root.path().join(".openbitfun-maintenance")).unwrap();
        std::fs::write(
            root.path().join(".openbitfun-maintenance/journal.json"),
            br#"{"integrations":{"registry":{"machine":true}}}"#,
        )
        .unwrap();
        assert!(windows_machine_install(root.path()));
    }

    #[test]
    fn download_request_preserves_legacy_payloads_and_checks_the_selected_version() {
        let legacy: DownloadUpdateRequest = serde_json::from_str("{}").unwrap();
        assert!(legacy.validate_version("2.0.0").is_ok());
        let roundtrip: DownloadUpdateRequest =
            serde_json::from_str(&serde_json::to_string(&legacy).unwrap()).unwrap();
        assert!(roundtrip.expected_version.is_none());
        let request: DownloadUpdateRequest =
            serde_json::from_str(r#"{"expectedVersion":"2.0.0","futureField":true}"#).unwrap();
        assert!(request.validate_version("2.0.0").is_ok());
        assert!(request
            .validate_version("2.1.0")
            .unwrap_err()
            .contains("Update version changed"));
    }

    fn record(bytes: &[u8]) -> PendingUpdateRecord {
        PendingUpdateRecord {
            version: "2.0.0".into(),
            platform: "test".into(),
            signature: "invalid".into(),
            sha256: format!("{:x}", Sha256::digest(bytes)),
            package_kind: Some(package_kind().into()),
        }
    }

    #[test]
    fn staged_update_survives_reload_and_is_not_offered_after_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let record = record(b"package");
        save_package(dir.path(), &record, b"package").unwrap();
        assert_eq!(
            read_record(dir.path(), &"1.0.0".parse().unwrap(), "test")
                .unwrap()
                .unwrap()
                .version,
            "2.0.0"
        );
        assert!(read_record(dir.path(), &"2.0.0".parse().unwrap(), "test")
            .unwrap()
            .is_none());
        assert!(read_record(dir.path(), &"1.0.0".parse().unwrap(), "other")
            .unwrap()
            .is_none());
    }

    #[test]
    fn corrupt_metadata_is_preserved_and_invalid_package_paths_are_rejected() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(RECORD_NAME), b"invalid").unwrap();
        assert!(read_record(dir.path(), &"1.0.0".parse().unwrap(), "test").is_err());
        assert_eq!(
            std::fs::read(dir.path().join(RECORD_NAME)).unwrap(),
            b"invalid"
        );
        let mut record = record(b"package");
        record.sha256 = "../outside".into();
        assert!(record.package_name().is_err());
    }

    #[test]
    fn cached_bytes_cannot_bypass_signature_verification() {
        assert!(verify_package(b"tampered", &record(b"package"), "invalid").is_err());
        assert!(verify_package(b"package", &record(b"package"), "invalid").is_err());
    }

    #[test]
    fn explicit_redownload_atomically_replaces_the_pending_package() {
        let dir = tempfile::tempdir().unwrap();
        let first = record(b"first");
        save_package(dir.path(), &first, b"first").unwrap();
        // Retrying the same download must also work on Windows.
        save_package(dir.path(), &first, b"first").unwrap();
        let mut replacement = record(b"replacement");
        replacement.version = "2.1.0".into();
        save_package(dir.path(), &replacement, b"replacement").unwrap();
        let restored = read_record(dir.path(), &"1.0.0".parse().unwrap(), "test")
            .unwrap()
            .unwrap();
        assert_eq!(restored.version, "2.1.0");
        assert_eq!(
            std::fs::read(dir.path().join(restored.package_name().unwrap())).unwrap(),
            b"replacement"
        );
    }

    #[test]
    fn signed_cache_verifies_after_reload_and_rejects_tampering_even_with_a_new_checksum() {
        // Public fixture shared with the release-verification contract tests.
        let key = "dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IERENTQzQUM5RUY0NTIzRTMKUldUakkwWHZ5VHBVM1NOMXJWMHhLVlljSDBOY2x4YlpxVHA2clN1NEJPMWcyY2Qvd2U4VUR2b3AK";
        let signature = "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUakkwWHZ5VHBVM2RVVFdoR3FNZDltSWNUeEQ1K2ZnNWRUSnYxWk5lUkZzd0h0MkdzSUhUSlV6a0haUTdNZm1aemM5QVBQWW50UWgvaWpFcEp1Zkp4SERWdnhIc1g2YUFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzg4NDg2NTU4CWZpbGU6Lm9wZW5iaXRmdW4tbWluaXNpZ24tZml4dHVyZS50eHQKa1QxdDQ3bWtLVlhaZUdFSjR4R0V5R1Z3REVnUlI0RGJqbHFoZkVHdkdLSlFyTGJ5Z05JRTI5V3dwdXRkSFpZckUrK0RaUVVJYUJod1dzcmVydHZnQXc9PQo=";
        let bytes = b"hello-openbitfun\n";
        let mut record = record(bytes);
        record.signature = signature.into();
        let dir = tempfile::tempdir().unwrap();
        save_package(dir.path(), &record, bytes).unwrap();
        let mut restored = read_record(dir.path(), &"1.0.0".parse().unwrap(), "test")
            .unwrap()
            .unwrap();
        verify_package(bytes, &restored, key).unwrap();
        restored.sha256 = format!("{:x}", Sha256::digest(b"tampered"));
        assert!(verify_package(b"tampered", &restored, key).is_err());
    }

    #[test]
    fn record_accepts_additive_fields() {
        let mut json = serde_json::to_value(record(b"package")).unwrap();
        json["futureField"] = true.into();
        let decoded: PendingUpdateRecord = serde_json::from_value(json).unwrap();
        let roundtrip: PendingUpdateRecord =
            serde_json::from_slice(&serde_json::to_vec(&decoded).unwrap()).unwrap();
        assert_eq!(roundtrip.version, "2.0.0");
    }

    #[test]
    fn legacy_and_other_package_formats_are_preserved_for_explicit_redownload() {
        let dir = tempfile::tempdir().unwrap();
        let mut record = record(b"package");
        for kind in [None, Some("other-format".into())] {
            record.package_kind = kind;
            save_package(dir.path(), &record, b"package").unwrap();
            assert!(read_record(dir.path(), &"1.0.0".parse().unwrap(), "test")
                .unwrap_err()
                .contains("installation format"));
            assert!(dir.path().join(record.package_name().unwrap()).is_file());
        }
        let mut legacy = serde_json::to_value(&record).unwrap();
        legacy.as_object_mut().unwrap().remove("packageKind");
        let decoded: PendingUpdateRecord = serde_json::from_value(legacy).unwrap();
        assert!(decoded.package_kind.is_none());
    }

    #[test]
    fn installation_receipts_report_failures_and_a_still_running_old_version() {
        let dir = tempfile::tempdir().unwrap();
        for success in [false, true] {
            std::fs::write(
                dir.path().join(RECEIPT_NAME),
                serde_json::to_vec(&serde_json::json!({"version":"2.0.0", "success":success}))
                    .unwrap(),
            )
            .unwrap();
            assert!(pending_response(dir.path(), record(b"package"))
                .unwrap()
                .install_error
                .is_some());
        }
        std::fs::write(
            dir.path().join(RECEIPT_NAME),
            br#"{"version":"1.5.0", "success":false,"error":"old failure"}"#,
        )
        .unwrap();
        assert!(pending_response(dir.path(), record(b"package"))
            .unwrap()
            .install_error
            .is_none());
        std::fs::write(dir.path().join(RECEIPT_NAME), b"invalid").unwrap();
        assert!(pending_response(dir.path(), record(b"package")).is_err());
        assert_eq!(
            std::fs::read(dir.path().join(RECEIPT_NAME)).unwrap(),
            b"invalid"
        );
    }
}
