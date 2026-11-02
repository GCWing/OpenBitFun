//! Runtime-free Claude Code source adapter.

mod agent_source;
mod command_source;
mod hook_source;
mod instruction_source;
mod mcp_source;
pub mod session;

pub use agent_source::{ClaudeCodeSubagentProvider, ClaudeCodeSubagentProviderOptions};
pub use command_source::{ClaudeCodeCommandProvider, ClaudeCodeCommandProviderOptions};
pub use hook_source::{ClaudeCodeHookProvider, ClaudeCodeHookProviderOptions};
pub use instruction_source::{
    load_claude_code_user_instructions, ClaudeCodeInstructionSourceOptions,
};
pub use mcp_source::{ClaudeCodeMcpProvider, ClaudeCodeMcpProviderOptions};
