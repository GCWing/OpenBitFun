//! Persisted bootstrap records shared by the Desktop host and lightweight shell.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchRecord {
    #[serde(default = "protocol_version")]
    pub protocol_version: u32,
    pub launch_id: String,
    pub app_id: String,
    #[serde(default)]
    pub workspace_path: Option<String>,
    pub data_dir: PathBuf,
    pub user_root: PathBuf,
    #[serde(default, skip_serializing_if = "crate::HostChannel::is_default")]
    pub host_channel: crate::HostChannel,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_home: Option<PathBuf>,
    pub host_executable: PathBuf,
    pub name: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}
fn protocol_version() -> u32 {
    1
}

pub fn launch_path(record: &LaunchRecord) -> PathBuf {
    record
        .host_channel
        .directory(&record.data_dir)
        .join("launchers")
        .join(&record.launch_id)
        .join("launch.json")
}

pub fn read_record(path: &Path) -> Result<LaunchRecord, String> {
    let record: LaunchRecord =
        serde_json::from_slice(&std::fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if !matches!(record.protocol_version, 1 | 2)
        || (record.protocol_version == 1 && !record.host_channel.is_default())
        || uuid::Uuid::parse_str(&record.launch_id).is_err()
    {
        return Err("Unsupported MiniApp launcher; recreate it in OpenBitFun".into());
    }
    Ok(record)
}

pub fn write_record(record: &LaunchRecord) -> Result<PathBuf, String> {
    let path = launch_path(record);
    crate::private_json(&path, record)?;
    Ok(path)
}

pub fn launch_manifest() -> Result<Option<PathBuf>, String> {
    let args: Vec<_> = std::env::args_os().collect();
    if let Some(index) = args.iter().position(|arg| arg == "--miniapp-launch") {
        return args
            .get(index + 1)
            .map(|path| Some(PathBuf::from(path)))
            .ok_or_else(|| "--miniapp-launch requires a launch record path".into());
    }
    #[cfg(target_os = "macos")]
    if let Ok(exe) = std::env::current_exe() {
        if let Some(contents) = exe.parent().and_then(|parent| parent.parent()) {
            let path = contents.join("Resources/openbitfun-miniapp.json");
            if path.is_file() {
                return Ok(Some(path));
            }
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate as ipc;
    fn fixture(root: &Path) -> LaunchRecord {
        LaunchRecord {
            protocol_version: 1,
            launch_id: uuid::Uuid::new_v4().to_string(),
            app_id: "notes".into(),
            workspace_path: None,
            data_dir: root.join("data"),
            user_root: root.to_path_buf(),
            host_channel: Default::default(),
            product_home: None,
            host_executable: root.join("OpenBitFun"),
            name: "Notes".into(),
            extra: Default::default(),
        }
    }
    #[test]
    fn launch_records_accept_legacy_optional_fields_and_reject_future_protocol_without_rewriting() {
        let root = tempfile::tempdir().unwrap();
        let record = fixture(root.path());
        let path = write_record(&record).unwrap();
        let mut value = serde_json::to_value(&record).unwrap();
        value.as_object_mut().unwrap().remove("protocolVersion");
        value.as_object_mut().unwrap().remove("workspacePath");
        value["futureField"] = serde_json::json!({"keep":"untouched"});
        ipc::private_json(&path, &value).unwrap();
        let legacy = read_record(&path).unwrap();
        assert_eq!(legacy.launch_id, record.launch_id);
        assert_eq!(legacy.workspace_path, None);
        assert_eq!(legacy.host_channel, crate::HostChannel::Default);
        assert_eq!(legacy.product_home, None);
        write_record(&legacy).unwrap();
        let rewritten: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(rewritten["futureField"], value["futureField"]);
        value["protocolVersion"] = serde_json::json!(99);
        ipc::private_json(&path, &value).unwrap();
        let before = std::fs::read(&path).unwrap();
        assert!(read_record(&path).is_err());
        assert_eq!(std::fs::read(path).unwrap(), before);
    }

    #[test]
    fn development_records_share_product_storage_and_keep_host_discovery_separate() {
        let root = tempfile::tempdir().unwrap();
        let stable = fixture(root.path());
        let stable_path = write_record(&stable).unwrap();
        let stable_bytes = std::fs::read(&stable_path).unwrap();
        let mut development = stable.clone();
        // v1 shells reject v2 records instead of silently attaching to the
        // installed host after ignoring the new hostChannel field.
        development.protocol_version = 2;
        development.host_channel = crate::HostChannel::Development;
        development.product_home = Some(root.path().join("home"));
        let development_path = write_record(&development).unwrap();
        assert_ne!(development_path, stable_path);
        assert_ne!(
            development
                .host_channel
                .endpoint_path(&development.data_dir),
            crate::endpoint_path(&stable.data_dir)
        );
        let restored = read_record(&development_path).unwrap();
        assert_eq!(restored.data_dir, stable.data_dir);
        assert_eq!(restored.user_root, stable.user_root);
        assert_eq!(restored.host_channel, crate::HostChannel::Development);
        assert_eq!(restored.product_home, development.product_home);
        assert_eq!(std::fs::read(stable_path).unwrap(), stable_bytes);
        development.protocol_version = 1;
        ipc::private_json(&development_path, &development).unwrap();
        assert!(read_record(&development_path).is_err());
    }
}
