mod automation;
mod executor;
pub mod platform;
mod runtime;
pub mod server;
pub mod webdriver;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};

use tauri::AppHandle;

use server::AppState;

pub use automation::EmbeddedWebviewAutomation;

const DEFAULT_WEBDRIVER_LABEL: &str = "main";

static SERVER_STARTED: AtomicBool = AtomicBool::new(false);
static SHARED_STATE: OnceLock<Arc<AppState>> = OnceLock::new();

fn shared_state(app: AppHandle, preferred_label: String, port: u16) -> Arc<AppState> {
    SHARED_STATE
        .get_or_init(|| Arc::new(AppState::new(app, preferred_label, port)))
        .clone()
}

pub(crate) fn automation_state(app: AppHandle) -> Arc<AppState> {
    shared_state(app, DEFAULT_WEBDRIVER_LABEL.to_string(), 0)
}

pub fn maybe_start(app: AppHandle) {
    if !(cfg!(debug_assertions) || cfg!(feature = "embedded")) {
        return;
    }

    let Some(port) = std::env::var("OPENBITFUN_WEBDRIVER_PORT")
        .ok()
        .and_then(|raw| raw.parse::<u16>().ok())
    else {
        return;
    };

    if SERVER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }

    let preferred_label = std::env::var("OPENBITFUN_WEBDRIVER_LABEL")
        .unwrap_or_else(|_| DEFAULT_WEBDRIVER_LABEL.into());
    let state = shared_state(app, preferred_label, port);
    server::start(state);
}
