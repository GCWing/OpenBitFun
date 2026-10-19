//! AI provider module
//!
//! Provides a unified interface for different AI providers

pub mod anthropic;
pub mod gemini;
pub mod openai;
pub(crate) mod opencode;
pub(crate) mod shared;
#[cfg(feature = "subscription-auth")]
pub(crate) mod workbuddy;

pub use anthropic::AnthropicMessageConverter;
pub use gemini::GeminiMessageConverter;
