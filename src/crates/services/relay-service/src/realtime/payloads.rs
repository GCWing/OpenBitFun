//! Short-lived opaque RPC payloads. HTTP streams bulk bytes while Socket.IO
//! carries a small reference; slow file transfers never occupy the event lane.
use super::*;
use axum::{
    body::Body,
    extract::{Path, Request, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    Extension, Json,
};
use futures_util::StreamExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

pub(crate) const MAX_BYTES: usize = 64 * 1024 * 1024;
const DISK_BUDGET: usize = 512 * 1024 * 1024;
const TTL: Duration = Duration::from_secs(300);

struct Payload {
    account: String,
    file: tempfile::TempPath,
    size: usize,
    expires: std::time::Instant,
    _storage: Vec<OwnedSemaphorePermit>,
}

pub(super) struct Payloads {
    entries: Mutex<HashMap<String, Arc<Payload>>>,
    storage: Arc<Semaphore>,
}

impl Payloads {
    pub(super) fn new() -> Arc<Self> {
        let store = Arc::new(Self {
            entries: Mutex::new(HashMap::new()),
            storage: Arc::new(Semaphore::new(DISK_BUDGET)),
        });
        let weak = Arc::downgrade(&store);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(30));
            loop {
                interval.tick().await;
                let Some(store) = weak.upgrade() else {
                    break;
                };
                store
                    .entries
                    .lock()
                    .unwrap()
                    .retain(|_, entry| entry.expires > std::time::Instant::now());
            }
        });
        store
    }
}

pub(super) async fn upload(
    State(state): State<AppState>,
    Extension(store): Extension<Arc<Payloads>>,
    request: Request,
) -> Result<Json<Value>, StatusCode> {
    let auth = crate::routes::devices::validate_user(&state, request.headers()).await?;
    if request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n > MAX_BYTES)
    {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let overhead = store
        .storage
        .clone()
        .try_acquire_many_owned(16 * 1024)
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    // Tempfile uses private, create-new files and removes cancelled uploads.
    let temporary = tempfile::NamedTempFile::new().map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
    let (file, path) = temporary.into_parts();
    let mut file = tokio::fs::File::from_std(file);
    let mut stream = request.into_body().into_data_stream();
    let mut size = 0usize;
    let mut storage = vec![overhead];
    while let Some(chunk) = tokio::time::timeout(Duration::from_secs(30), stream.next())
        .await
        .map_err(|_| StatusCode::REQUEST_TIMEOUT)?
    {
        let chunk = chunk.map_err(|_| StatusCode::BAD_REQUEST)?;
        size = size
            .checked_add(chunk.len())
            .filter(|size| *size <= MAX_BYTES)
            .ok_or(StatusCode::PAYLOAD_TOO_LARGE)?;
        storage.push(
            store
                .storage
                .clone()
                .try_acquire_many_owned(chunk.len() as u32)
                .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?,
        );
        file.write_all(&chunk)
            .await
            .map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
    }
    if size == 0 {
        return Err(StatusCode::BAD_REQUEST);
    }
    file.flush()
        .await
        .map_err(|_| StatusCode::INSUFFICIENT_STORAGE)?;
    drop(file);
    let id = uuid::Uuid::new_v4().to_string();
    store.entries.lock().unwrap().insert(
        id.clone(),
        Arc::new(Payload {
            account: auth.user_id,
            file: path,
            size,
            expires: std::time::Instant::now() + TTL,
            _storage: storage,
        }),
    );
    Ok(Json(json!({"$relayPayload": {"id":id,"bytes":size}})))
}

pub(super) async fn download(
    State(state): State<AppState>,
    Extension(store): Extension<Arc<Payloads>>,
    Path(id): Path<String>,
    headers: HeaderMap,
) -> Result<Response, StatusCode> {
    let auth = crate::routes::devices::validate_user(&state, &headers).await?;
    let entry = store
        .entries
        .lock()
        .unwrap()
        .get(&id)
        .filter(|entry| entry.account == auth.user_id && entry.expires > std::time::Instant::now())
        .cloned()
        .ok_or(StatusCode::NOT_FOUND)?;
    let file = tokio::fs::File::open(&entry.file)
        .await
        .map_err(|_| StatusCode::NOT_FOUND)?;
    let size = entry.size;
    // Keep the file/storage lease alive until the reader completes or cancels.
    let stream = futures_util::stream::try_unfold((file, entry), |(mut file, entry)| async move {
        let mut buffer = vec![0u8; 64 * 1024];
        let read = file.read(&mut buffer).await?;
        if read == 0 {
            return Ok::<_, std::io::Error>(None);
        }
        buffer.truncate(read);
        Ok(Some((buffer, (file, entry))))
    });
    Ok((
        [
            ("content-type", "application/octet-stream".to_string()),
            ("content-length", size.to_string()),
            ("cache-control", "no-store".to_string()),
        ],
        Body::from_stream(stream),
    )
        .into_response())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tower::ServiceExt;
    #[tokio::test]
    async fn bulk_transfer_exceeds_ws_size_is_account_scoped_and_revocable() {
        let db = Arc::new(crate::db::connect(":memory:").await.unwrap());
        let mut tokens = Vec::new();
        for account in ["owner", "other"] {
            crate::db::UserRow::create(&db, account, account)
                .await
                .unwrap();
            crate::db::DeviceRow::upsert(&db, "device", account, "device", None, None)
                .await
                .unwrap();
            tokens.push(
                AuthToken::create(&db, account, "device")
                    .await
                    .unwrap()
                    .token,
            );
        }
        let router = crate::build_relay_router(
            Arc::new(crate::MemoryAssetStore::new()),
            std::time::Instant::now(),
            db.clone(),
            "test",
        );
        let bytes = vec![42; 3 * 1024 * 1024];
        let upload = Request::builder()
            .method("POST")
            .uri("/v1/rpc/payloads")
            .header("authorization", format!("Bearer {}", tokens[0]))
            .body(Body::from(bytes.clone()))
            .unwrap();
        let response = router.clone().oneshot(upload).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body = axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap();
        let reference: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(reference["$relayPayload"]["bytes"], bytes.len());
        let path = format!(
            "/v1/rpc/payloads/{}",
            reference["$relayPayload"]["id"].as_str().unwrap()
        );
        let get = |token: &str| {
            Request::builder()
                .uri(&path)
                .header("authorization", format!("Bearer {token}"))
                .body(Body::empty())
                .unwrap()
        };
        assert_eq!(
            router
                .clone()
                .oneshot(get(&tokens[1]))
                .await
                .unwrap()
                .status(),
            StatusCode::NOT_FOUND
        );
        let response = router.clone().oneshot(get(&tokens[0])).await.unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            axum::body::to_bytes(response.into_body(), MAX_BYTES)
                .await
                .unwrap()
                .as_ref(),
            bytes
        );
        sqlx::query("DELETE FROM auth_tokens WHERE token=?")
            .bind(&tokens[0])
            .execute(&*db)
            .await
            .unwrap();
        assert_eq!(
            router.oneshot(get(&tokens[0])).await.unwrap().status(),
            StatusCode::UNAUTHORIZED
        );
    }
}
