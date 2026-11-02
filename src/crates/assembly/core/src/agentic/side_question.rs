//! Shared `/btw` prompt helpers and compatibility exports for runtime tracking.

use crate::agentic::core::{InternalReminderKind, Message};
pub use openbitfun_agent_runtime::side_question::{
    ActiveBtwTurn, BtwTurnWatch, SideQuestionRuntime, BTW_TURN_POLL_INTERVAL,
};

pub fn btw_system_reminder() -> &'static str {
    r#"This is a side question from the user. You must answer this question directly.

IMPORTANT CONTEXT:
- You are a separate, lightweight agent spawned to answer this question
- The main agent is NOT interrupted - it continues working independently in the background
- You share the conversation context but are a completely separate instance
- Do NOT reference being interrupted or what you were "previously doing" - that framing is incorrect

CRITICAL CONSTRAINTS:
- Use tools only when necessary to answer the question correctly
- You should answer the question directly, using what you already know from the conversation context as your starting point
- Do NOT say things like "Let me try...", "I'll now...", "Let me check...", or promise to take any action unless you actually take that action in this side thread
- If you don't know the answer, say so clearly - do not pretend you already checked something
- Reply concisely and match the user's language

Simply answer the question with the information you have, and use tools only when needed."#
}

pub fn build_btw_user_input(question: &str) -> (String, Vec<Message>) {
    (
        question.trim().to_string(),
        vec![Message::internal_reminder(
            InternalReminderKind::SideQuestion,
            btw_system_reminder(),
        )],
    )
}
