//! LoopX MiniApp contracts, typed service port, and pure lifecycle policy.

mod bridge;
pub mod policy;
pub mod ports;
pub mod types;

pub(crate) use bridge::private_bridge_extension;
pub use policy::*;
pub use ports::*;
pub use types::*;
