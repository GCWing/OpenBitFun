//! Runtime-host capability gate; a product surface name is not a provider.
use std::sync::atomic::{AtomicBool, Ordering};
static COMPUTER_USE_HOST_AVAILABLE: AtomicBool = AtomicBool::new(false);

pub fn set_computer_use_host_available(available: bool) {
    COMPUTER_USE_HOST_AVAILABLE.store(available, Ordering::SeqCst);
}
pub fn computer_use_host_available() -> bool {
    COMPUTER_USE_HOST_AVAILABLE.load(Ordering::SeqCst)
}
// Retained source compatibility for existing embedders.
pub use computer_use_host_available as computer_use_desktop_available;
pub use set_computer_use_host_available as set_computer_use_desktop_available;
