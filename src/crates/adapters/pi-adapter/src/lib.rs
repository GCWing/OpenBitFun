//! Static PI extension discovery; no JavaScript evaluation or package installation.
mod hook_source;
pub use hook_source::{PiHookProvider, PiHookProviderOptions};
pub mod session;
mod skill_source;
pub use skill_source::{PiSkillRoot, PiSkillRootProvider, PiSkillRootReport};
