//! Product assembly registration; the renderer and its transport stay in hosts.
use serde_json::Value;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};
type CheckFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
type Checker = Arc<dyn Fn(Value) -> CheckFuture + Send + Sync>;
static CHECKER: OnceLock<Checker> = OnceLock::new();
pub fn set_generative_ui_checker(checker: Checker) {
    let _ = CHECKER.set(checker);
}
pub async fn check_generative_ui(request: Value) -> Result<Value, String> {
    CHECKER
        .get()
        .ok_or("This host has no GenUI renderer checker; application delivery is unsupported")?(
        request,
    )
    .await
}
