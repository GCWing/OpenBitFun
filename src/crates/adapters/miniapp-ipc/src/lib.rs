//! Desktop shell transport. Private per-user local IPC, bounded frames, no TCP listener.
pub mod launcher;
pub use openbitfun_product_domains::miniapp::instances::MINIAPP_PRESENTATION_PROTOCOL;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MINIAPP_CUSTOM_CHROME_CAPABILITY: &str = "miniapp_custom_chrome_v1";
pub const MINIAPP_CHAT_SNAPSHOT_CAPABILITY: &str = "miniapp_chat_snapshot_v1";

const MAX_FRAME: usize = 16 * 1024 * 1024;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Endpoint {
    pub protocol_version: u32,
    pub address: String,
    pub token: String,
    pub host_epoch: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request {
    pub token: String,
    pub protocol_version: u32,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

impl Request {
    pub fn authorized(&self, endpoint: &Endpoint) -> bool {
        self.token == endpoint.token
            && self.protocol_version == endpoint.protocol_version
            && self.protocol_version == MINIAPP_PRESENTATION_PROTOCOL
    }
}

pub async fn read<T: DeserializeOwned, S: AsyncRead + Unpin>(stream: &mut S) -> Result<T, String> {
    let size = stream.read_u32().await.map_err(|e| e.to_string())? as usize;
    if size > MAX_FRAME {
        return Err("MiniApp IPC frame is too large".into());
    }
    let mut bytes = vec![0; size];
    stream
        .read_exact(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

pub async fn write<T: Serialize, S: AsyncWrite + Unpin>(
    stream: &mut S,
    value: &T,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    if bytes.len() > MAX_FRAME {
        return Err("MiniApp IPC frame is too large".into());
    }
    stream
        .write_u32(bytes.len() as u32)
        .await
        .map_err(|e| e.to_string())?;
    stream.write_all(&bytes).await.map_err(|e| e.to_string())?;
    stream.flush().await.map_err(|e| e.to_string())
}

pub fn endpoint_path(data_dir: &Path) -> PathBuf {
    data_dir.join("miniapp-desktop/host.json")
}

pub async fn call(endpoint: &Endpoint, method: &str, params: Value) -> Result<Value, String> {
    if endpoint.protocol_version != MINIAPP_PRESENTATION_PROTOCOL {
        return Err(
            "MiniApp launcher protocol is incompatible; recreate the system shortcut in OpenBitFun"
                .into(),
        );
    }
    #[cfg(unix)]
    let mut stream = tokio::net::UnixStream::connect(&endpoint.address)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    let mut stream = tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&endpoint.address)
        .map_err(|e| e.to_string())?;
    write(
        &mut stream,
        &Request {
            token: endpoint.token.clone(),
            protocol_version: MINIAPP_PRESENTATION_PROTOCOL,
            method: method.into(),
            params,
        },
    )
    .await?;
    let response: Result<Value, String> = read(&mut stream).await?;
    response
}

pub fn private_json(path: &Path, value: &impl Serialize) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing MiniApp data directory")?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(parent, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let mut file = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, value).map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[tokio::test]
    async fn existing_v1_client_connects_and_receives_host_response() {
        // A short socket directory avoids macOS sockaddr_un path limits.
        let directory = tempfile::tempdir_in("/tmp").unwrap();
        let address = directory.path().join("host.sock");
        let listener = tokio::net::UnixListener::bind(&address).unwrap();
        let endpoint = Endpoint {
            protocol_version: 1,
            address: address.to_string_lossy().into_owned(),
            token: "private".into(),
            host_epoch: "epoch".into(),
        };
        let expected = endpoint.clone();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request: Request = read(&mut socket).await.unwrap();
            assert!(request.authorized(&expected));
            assert_eq!(request.method, "ping");
            write(
                &mut socket,
                &Ok::<_, String>(serde_json::json!({"hostEpoch":"epoch"})),
            )
            .await
            .unwrap();
        });
        let response = call(&endpoint, "ping", Value::Null).await.unwrap();
        assert_eq!(response["hostEpoch"], "epoch");
        server.await.unwrap();
        let future = Endpoint {
            protocol_version: 99,
            ..endpoint
        };
        assert!(call(&future, "ping", Value::Null)
            .await
            .unwrap_err()
            .contains("incompatible"));
    }
    #[tokio::test]
    async fn framed_transport_requires_both_credentials_and_protocol() {
        let endpoint = Endpoint {
            address: "unused".into(),
            token: "private-token".into(),
            host_epoch: "host".into(),
            protocol_version: 1,
        };
        let (mut client, mut server) = tokio::io::duplex(1024);
        let request = Request {
            token: endpoint.token.clone(),
            protocol_version: 1,
            method: "ping".into(),
            params: Value::Null,
        };
        write(&mut client, &request).await.unwrap();
        let mut decoded: Request = read(&mut server).await.unwrap();
        assert!(decoded.authorized(&endpoint));
        decoded.protocol_version = 2;
        assert!(!decoded.authorized(&endpoint));
        decoded.protocol_version = 1;
        decoded.token = "different-user".into();
        assert!(!decoded.authorized(&endpoint));
    }
    #[tokio::test]
    async fn rejects_oversized_frames_before_allocating_payload() {
        let (mut writer, mut reader) = tokio::io::duplex(32);
        writer.write_u32((MAX_FRAME + 1) as u32).await.unwrap();
        assert!(read::<Value, _>(&mut reader)
            .await
            .unwrap_err()
            .contains("too large"));
    }
}
