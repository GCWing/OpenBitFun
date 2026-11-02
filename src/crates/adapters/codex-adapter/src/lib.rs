//! Runtime-free Codex source adapter.

mod agent_source;
mod hook_source;
mod instruction_source;
mod mcp_source;
mod pet_source;
pub mod session;

pub use pet_source::{builtin_pet_sources, BuiltinPetCatalog, BuiltinPetSource};

pub use agent_source::{CodexSubagentProvider, CodexSubagentProviderOptions};
pub use hook_source::{CodexHookProvider, CodexHookProviderOptions};
pub use instruction_source::{load_codex_user_instructions, CodexInstructionSourceOptions};
pub use mcp_source::{CodexMcpProvider, CodexMcpProviderOptions};

/// User-installed Petdex packages; shares the configurable Codex root.
pub fn pet_source_root() -> std::path::PathBuf {
    CodexHookProviderOptions::from_environment()
        .codex_home
        .join("pets")
}

#[cfg(test)]
mod tests {
    #[test]
    fn pet_root_uses_configured_codex_home() {
        // This crate has no other environment-mutating unit tests.
        let previous = std::env::var_os("CODEX_HOME");
        let expected = std::env::temp_dir().join("openbitfun-codex-pet-root");
        std::env::set_var("CODEX_HOME", &expected);
        let actual = super::pet_source_root();
        match previous {
            Some(value) => std::env::set_var("CODEX_HOME", value),
            None => std::env::remove_var("CODEX_HOME"),
        }
        assert_eq!(actual, expected.join("pets"));
    }
}
