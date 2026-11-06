use std::net::SocketAddr;
use std::sync::Arc;

use tauri::AppHandle;
use tauri::Manager;
use tokio::sync::RwLock;

use crate::webdriver::SessionManager;

pub mod handlers;
pub mod response;
pub mod router;

pub struct AppState {
    pub app: AppHandle,
    pub preferred_label: String,
    port: u16,
    pub sessions: RwLock<SessionManager>,
}

impl AppState {
    pub fn new(app: AppHandle, preferred_label: String, port: u16) -> Self {
        Self {
            app,
            preferred_label,
            port,
            sessions: RwLock::new(SessionManager::new()),
        }
    }

    pub fn initial_window_label(&self) -> Option<String> {
        if self.app.get_webview(&self.preferred_label).is_some() {
            return Some(self.preferred_label.clone());
        }

        self.app.webview_windows().keys().next().cloned()
    }

    pub fn has_window(&self, label: &str) -> bool {
        self.app.get_webview(label).is_some()
    }

    pub fn window_labels(&self) -> Vec<String> {
        self.app.webview_windows().keys().cloned().collect()
    }
}

pub fn start(state: Arc<AppState>) {
    tokio::spawn(async move {
        if let Err(error) = serve(state).await {
            log::error!("Embedded WebDriver failed to start: {}", error);
        }
    });
}

async fn serve(state: Arc<AppState>) -> anyhow::Result<()> {
    let router = router::create_router(state.clone());
    let addr = SocketAddr::from(([127, 0, 0, 1], state.port));
    let listener = tokio::net::TcpListener::bind(addr).await?;
    log::info!("Embedded WebDriver listening on http://{}", addr);
    axum::serve(listener, router).await?;
    Ok(())
}
