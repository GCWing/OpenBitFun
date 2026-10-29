//! Controller-owned public image cache for MiniApp marketplace images.

use openbitfun_services_integrations::{
    market_image::MarketImageCache, miniapp_market::MarketClient,
};
use serde::Deserialize;
use tauri::Manager;
use tokio::sync::OnceCell;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketImageRequest {
    pub source: String,
}

#[tauri::command]
pub async fn market_image_load(
    app: tauri::AppHandle,
    request: MarketImageRequest,
) -> Result<tauri::ipc::Response, String> {
    static CACHE: OnceCell<MarketImageCache> = OnceCell::const_new();
    let cache = CACHE
        .get_or_try_init(|| async {
            let root = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?
                .join("market-images-v1");
            MarketImageCache::new(root, &MarketClient::configured_base_url())
        })
        .await?;
    cache
        .load(&request.source)
        .await
        .map(tauri::ipc::Response::new)
}
