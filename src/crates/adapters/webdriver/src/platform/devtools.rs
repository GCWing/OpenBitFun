use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Webview;
use tauri_runtime_cef::cef::rc::Rc;
use tauri_runtime_cef::cef::{
    self, DevToolsMessageObserver, ImplBrowser, ImplBrowserHost, ImplDevToolsMessageObserver,
    WrapDevToolsMessageObserver,
};
use tauri_runtime_cef::{allocate_devtools_message_id, WebviewCefExt};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;

cef::wrap_dev_tools_message_observer! {
    struct CommandObserver {
        id: i32,
        reply: Arc<Mutex<Option<oneshot::Sender<Reply>>>>,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(
            &self,
            _browser: Option<&mut cef::Browser>,
            message_id: i32,
            success: i32,
            result: Option<&[u8]>,
        ) {
            if message_id != self.id {
                return;
            }
            if let Some(sender) = self.reply.lock().unwrap().take() {
                let bytes = result.unwrap_or_default();
                let reply = if success != 0 {
                    serde_json::from_slice(bytes)
                        .map_err(|error| format!("Invalid DevTools response: {error}"))
                } else {
                    Err(String::from_utf8_lossy(bytes).into_owned())
                };
                let _ = sender.send(reply);
            }
        }
    }
}

pub async fn call_devtools(
    webview: &Webview,
    method: &str,
    params: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = allocate_devtools_message_id().map_err(|error| error.to_string())?;
    let message = json!({ "id": id, "method": method, "params": params }).to_string();
    let (registration_tx, registration_rx) = oneshot::channel();
    let (reply_tx, reply_rx) = oneshot::channel();

    webview
        .with_cef_webview(move |native| {
            let result = (|| {
                let host = native
                    .browser()
                    .host()
                    .ok_or("CEF browser host is unavailable")?;
                let mut observer = CommandObserver::new(id, Arc::new(Mutex::new(Some(reply_tx))));
                let registration = host
                    .add_dev_tools_message_observer(Some(&mut observer))
                    .ok_or("Failed to register DevTools observer")?;
                if host.send_dev_tools_message(Some(message.as_bytes())) != 1 {
                    return Err("CEF rejected the DevTools request");
                }
                Ok(registration)
            })();
            let _ = registration_tx.send(result);
        })
        .map_err(|error| format!("{method}: {error}"))?;

    tokio::time::timeout(timeout, async {
        // Dropping the registration also removes the observer on timeout or cancellation.
        let _registration = registration_rx
            .await
            .map_err(|_| format!("{method}: CEF webview was closed"))?
            .map_err(|error| format!("{method}: {error}"))?;
        reply_rx
            .await
            .map_err(|_| format!("{method}: response channel closed"))?
            .map_err(|error| format!("{method}: {error}"))
    })
    .await
    .map_err(|_| format!("{method}: timed out after {}ms", timeout.as_millis()))?
}
