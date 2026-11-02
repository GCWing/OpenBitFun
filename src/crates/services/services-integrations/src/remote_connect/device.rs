//! Device identity for Remote Connect pairing and account device routing.
//!
//! `device_id` is generated once and persisted under
//! `<OPENBITFUN_HOME>/device_identity.json` (normally `~/.openbitfun/device_identity.json`).
//! Hostname/MAC are refreshed for display only — they must not rewrite `device_id`,
//! because macOS private Wi‑Fi addresses and interface order make MAC unstable.

use std::path::PathBuf;
use std::sync::Mutex;

use anyhow::{anyhow, Context, Result};
use sha2::{Digest, Sha256};

/// Represents a device's identity used for pairing and account routing.
pub use crate::remote_persistence::DeviceIdentityRecord as DeviceIdentity;

static CACHED_IDENTITY: Mutex<Option<DeviceIdentity>> = Mutex::new(None);

#[cfg(test)]
thread_local! {
    static TEST_IDENTITY_PATH: std::cell::RefCell<Option<PathBuf>> = const { std::cell::RefCell::new(None) };
}

impl DeviceIdentity {
    /// Load the stable machine identity (persisted), creating it on first use.
    pub fn from_current_machine() -> Result<Self> {
        if let Ok(guard) = CACHED_IDENTITY.lock() {
            if let Some(cached) = guard.as_ref() {
                let mut identity = cached.clone();
                identity.device_name = get_hostname();
                identity.mac_address = get_mac_address();
                return Ok(identity);
            }
        }

        let mut identity = load_persisted()?.unwrap_or_else(compute_initial_identity);
        identity.device_name = get_hostname();
        identity.mac_address = get_mac_address();
        save_persisted(&identity)?;
        cache_identity(identity.clone());
        Ok(identity)
    }

    /// Align the local identity with the account-bound `device_id` from a
    /// login token / `AuthOk`. Needed when a prior MAC-derived id drifted
    /// while an existing session still authenticates as the old id.
    pub fn adopt_account_device_id(device_id: &str) -> Result<Self> {
        let device_id = device_id.trim();
        if !is_valid_device_id(device_id) {
            return Err(anyhow!("invalid account device_id"));
        }

        let mut identity = Self::from_current_machine()?;
        if identity.device_id == device_id {
            return Ok(identity);
        }

        log::info!(
            "Adopting account device_id {} (was {})",
            device_id,
            identity.device_id
        );
        identity.device_id = device_id.to_string();
        identity.device_name = get_hostname();
        identity.mac_address = get_mac_address();
        save_persisted(&identity)?;
        cache_identity(identity.clone());
        Ok(identity)
    }
}

/// Collect metadata on the executing host, without changing its persisted identity.
/// Unsupported or failed probes are omitted, never sent as destructive nulls.
pub async fn local_device_metadata() -> serde_json::Value {
    async fn probe(program: &str, args: &[&str]) -> Option<String> {
        let mut command = openbitfun_services_core::process_manager::create_tokio_command(program);
        command.args(args).kill_on_drop(true);
        let output = tokio::time::timeout(std::time::Duration::from_secs(5), command.output())
            .await
            .ok()?
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let value = String::from_utf8(output.stdout).ok()?.trim().to_string();
        (!value.is_empty()).then_some(value)
    }
    // OpenHarmony/HarmonyOS PC builds compile for `target_env = "ohos"` while
    // `std::env::consts::OS` still reads `linux`, so the target env is the only
    // exact signal that separates HarmonyOS from a Linux distribution.
    let os = if cfg!(target_env = "ohos") {
        "HarmonyOS"
    } else {
        match std::env::consts::OS {
            "macos" => "macOS",
            "windows" => "Windows",
            "linux" => "Linux",
            other => other,
        }
    };
    #[cfg(target_os = "macos")]
    let (model, version) = (
        probe("/usr/sbin/sysctl", &["-n", "hw.model"]).await,
        probe("/usr/bin/sw_vers", &["-productVersion"]).await,
    );
    #[cfg(target_os = "linux")]
    let (model, version) = (
        tokio::fs::read_to_string("/sys/class/dmi/id/product_name")
            .await
            .ok()
            .or_else(|| std::fs::read_to_string("/proc/device-tree/model").ok())
            .map(|v| {
                v.trim_matches(|c: char| c.is_whitespace() || c == '\0')
                    .to_string()
            })
            .filter(|v| !v.is_empty()),
        match tokio::fs::read_to_string("/etc/os-release")
            .await
            .ok()
            .and_then(|text| linux_distribution_version(&text))
        {
            Some(version) => Some(version),
            None => probe("uname", &["-r"]).await,
        },
    );
    #[cfg(target_os = "windows")]
    let (model, version) = (
        probe(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_ComputerSystem).Model",
            ],
        )
        .await,
        probe(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "(Get-CimInstance Win32_OperatingSystem).Version",
            ],
        )
        .await,
    );
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    let (model, version): (Option<String>, Option<String>) = (None, None);
    metadata_payload(os, model, version)
}

// Validate independently: a broken firmware/probe value must not reject the
// entire PATCH. Omission preserves previously reported metadata on the Relay.
fn metadata_value(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control))
        .then(|| value.to_string())
}

fn metadata_payload(os: &str, model: Option<String>, version: Option<String>) -> serde_json::Value {
    let mut metadata = serde_json::Map::new();
    for (key, value) in [
        ("device_os", Some(os.to_string())),
        ("device_model", model),
        ("device_os_version", version),
    ] {
        if let Some(value) = value.as_deref().and_then(metadata_value) {
            metadata.insert(key.into(), value.into());
        }
    }
    serde_json::Value::Object(metadata)
}

#[cfg(any(target_os = "linux", test))]
fn linux_distribution_version(text: &str) -> Option<String> {
    // Match the system-info PRETTY_NAME convention without pulling its desktop
    // action feature into remote-connect or executing os-release as shell code.
    text.lines().find_map(|line| {
        let value = line.strip_prefix("PRETTY_NAME=")?.trim();
        let value = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        metadata_value(value)
    })
}

fn is_valid_device_id(device_id: &str) -> bool {
    device_id.len() == 32 && device_id.chars().all(|c| c.is_ascii_hexdigit())
}

fn compute_initial_identity() -> DeviceIdentity {
    let device_name = get_hostname();
    let mac_address = get_mac_address();

    let mut hasher = Sha256::new();
    hasher.update(device_name.as_bytes());
    hasher.update(b":");
    hasher.update(mac_address.as_bytes());
    let hash = hasher.finalize();
    let device_id = hash[..16]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    DeviceIdentity {
        device_id,
        device_name,
        mac_address,
    }
}

fn identity_file_path() -> Result<PathBuf> {
    #[cfg(test)]
    {
        let override_path = TEST_IDENTITY_PATH.with(|cell| cell.borrow().clone());
        if let Some(path) = override_path {
            return Ok(path);
        }
    }

    if let Ok(path) = std::env::var("OPENBITFUN_DEVICE_IDENTITY_PATH") {
        let path = path.trim();
        if !path.is_empty() {
            return Ok(PathBuf::from(path));
        }
    }

    let home = super::product_home_dir()
        .ok_or_else(|| anyhow!("cannot determine OpenBitFun home directory"))?;
    Ok(home.join("device_identity.json"))
}

fn load_persisted() -> Result<Option<DeviceIdentity>> {
    let path = identity_file_path()?;
    crate::remote_persistence::read_device_identity(&path)
        .context("read device identity")
        .map_err(|error| error.context(path.display().to_string()))
}

fn save_persisted(identity: &DeviceIdentity) -> Result<()> {
    let path = identity_file_path()?;
    crate::remote_persistence::write_device_identity(&path, identity)
        .context("write device identity file")
}

fn cache_identity(identity: DeviceIdentity) {
    if let Ok(mut guard) = CACHED_IDENTITY.lock() {
        *guard = Some(identity);
    }
}

fn get_hostname() -> String {
    hostname::get()
        .ok()
        .and_then(|h| h.into_string().ok())
        .unwrap_or_else(|| "unknown-host".to_string())
}

fn get_mac_address() -> String {
    mac_address::get_mac_address()
        .ok()
        .flatten()
        .map(|ma| ma.to_string())
        .unwrap_or_else(|| "00:00:00:00:00:00".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static TEST_LOCK: Mutex<()> = Mutex::new(());

    fn with_temp_identity_path<F: FnOnce()>(f: F) {
        let _guard = TEST_LOCK.lock().unwrap();
        let path = std::env::temp_dir().join(format!(
            "openbitfun-device-identity-{}-{}.json",
            std::process::id(),
            uuid_like()
        ));
        let _ = std::fs::remove_file(&path);
        TEST_IDENTITY_PATH.with(|cell| *cell.borrow_mut() = Some(path.clone()));
        if let Ok(mut cache) = CACHED_IDENTITY.lock() {
            *cache = None;
        }
        f();
        let _ = std::fs::remove_file(&path);
        TEST_IDENTITY_PATH.with(|cell| *cell.borrow_mut() = None);
        if let Ok(mut cache) = CACHED_IDENTITY.lock() {
            *cache = None;
        }
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        format!("{nanos:x}")
    }

    #[test]
    fn metadata_filters_each_field_independently_by_bytes_and_controls() {
        assert_eq!(metadata_value(&"a".repeat(256)), Some("a".repeat(256)));
        assert!(metadata_value(&"a".repeat(257)).is_none());
        assert!(metadata_value(&"界".repeat(86)).is_none());
        for invalid in ["", "   ", "bad\0model", "bad\tmodel", "bad\u{7f}model"] {
            assert!(metadata_value(invalid).is_none());
        }
        assert_eq!(
            metadata_payload(
                "Linux",
                Some("x".repeat(257)),
                Some(" Ubuntu 24.04\n".into())
            ),
            serde_json::json!({"device_os": "Linux", "device_os_version": "Ubuntu 24.04"})
        );
        assert_eq!(
            metadata_payload("Windows", Some("PC".into()), Some("bad\0version".into())),
            serde_json::json!({"device_os": "Windows", "device_model": "PC"})
        );
        assert_eq!(
            metadata_payload("macOS", None, None),
            serde_json::json!({"device_os": "macOS"})
        );
    }

    #[test]
    fn linux_distribution_version_is_data_not_shell() {
        assert_eq!(
            linux_distribution_version("NAME=Ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n"),
            Some("Ubuntu 24.04 LTS".into())
        );
        assert_eq!(
            linux_distribution_version("PRETTY_NAME='Debian GNU/Linux 12'"),
            Some("Debian GNU/Linux 12".into())
        );
        assert!(linux_distribution_version("VERSION_ID=24.04").is_none());
        assert!(
            linux_distribution_version(&format!("PRETTY_NAME=\"{}\"", "x".repeat(257))).is_none()
        );
        assert!(linux_distribution_version("PRETTY_NAME=\"bad\0version\"").is_none());
    }

    #[tokio::test]
    async fn local_metadata_has_display_os_and_only_non_destructive_valid_fields() {
        let metadata = local_device_metadata().await;
        // Pins the exact strings the Web UI selects device artwork on.
        let expected = if cfg!(target_env = "ohos") {
            "HarmonyOS"
        } else {
            match std::env::consts::OS {
                "macos" => "macOS",
                "windows" => "Windows",
                "linux" => "Linux",
                other => other,
            }
        };
        assert_eq!(metadata["device_os"], expected);
        for (key, value) in metadata.as_object().unwrap() {
            assert!(["device_os", "device_model", "device_os_version"].contains(&key.as_str()));
            let value = value.as_str().unwrap();
            assert_eq!(metadata_value(value).as_deref(), Some(value));
        }
    }

    #[test]
    fn test_device_identity_creation() {
        with_temp_identity_path(|| {
            let identity = DeviceIdentity::from_current_machine().unwrap();
            assert!(!identity.device_id.is_empty());
            assert!(!identity.device_name.is_empty());
            assert_eq!(identity.device_id.len(), 32);
        });
    }

    #[test]
    fn test_device_identity_stable_across_calls() {
        with_temp_identity_path(|| {
            let id1 = DeviceIdentity::from_current_machine().unwrap();
            let id2 = DeviceIdentity::from_current_machine().unwrap();
            assert_eq!(id1.device_id, id2.device_id);
        });
    }

    #[test]
    fn test_device_identity_persists_across_cache_clear() {
        with_temp_identity_path(|| {
            let id1 = DeviceIdentity::from_current_machine().unwrap();
            if let Ok(mut cache) = CACHED_IDENTITY.lock() {
                *cache = None;
            }
            let id2 = DeviceIdentity::from_current_machine().unwrap();
            assert_eq!(id1.device_id, id2.device_id);
        });
    }

    #[test]
    fn test_adopt_account_device_id_rewrites_persisted_id() {
        with_temp_identity_path(|| {
            let original = DeviceIdentity::from_current_machine().unwrap();
            let adopted_id = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
            let adopted = DeviceIdentity::adopt_account_device_id(adopted_id).unwrap();
            assert_eq!(adopted.device_id, adopted_id);
            assert_ne!(adopted.device_id, original.device_id);

            if let Ok(mut cache) = CACHED_IDENTITY.lock() {
                *cache = None;
            }
            let reloaded = DeviceIdentity::from_current_machine().unwrap();
            assert_eq!(reloaded.device_id, adopted_id);
        });
    }
}
