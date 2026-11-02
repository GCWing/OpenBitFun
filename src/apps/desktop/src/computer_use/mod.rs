//! Desktop wiring for the shared native Computer Use provider.
pub use openbitfun_computer_use::NativeComputerUseHost as DesktopComputerUseHost;
pub(crate) use openbitfun_computer_use::{
    control_session, grants, permissions, share_grants, share_targets, shared_preview,
};

#[cfg(all(feature = "devtools", target_os = "macos"))]
#[path = "native_control_roundtrip_tests.rs"]
pub(crate) mod native_control_roundtrip;
