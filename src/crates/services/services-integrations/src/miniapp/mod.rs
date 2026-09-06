//! MiniApp concrete integration services.

#[cfg(feature = "miniapp-runtime")]
pub mod builtin_io;
#[cfg(feature = "miniapp-runtime")]
pub mod host_dispatch;
#[cfg(feature = "miniapp-loopx")]
pub mod loopx_cli;
#[cfg(feature = "miniapp-loopx")]
pub mod loopx_github;
#[cfg(feature = "miniapp-loopx")]
pub mod loopx_workspace;
#[cfg(feature = "miniapp-runtime")]
pub mod storage;
#[cfg(feature = "miniapp-runtime")]
pub mod worker;
#[cfg(feature = "miniapp-runtime")]
pub mod worker_pool;
