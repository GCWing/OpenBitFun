use super::*;

impl AgentExecutionTool {
    pub(super) fn base_schema_properties() -> Map<String, Value> {
        let mut properties = Map::new();
        properties.insert(
            "prompt".to_string(),
            json!({
                "type": "string",
                "description": "The prompt to be sent to the agent. Keep it scoped and concise."
            }),
        );
        properties.insert(
            "subagent_type".to_string(),
            json!({
                "type": "string",
                "description": "Top-level agent type for a new subagent."
            }),
        );
        properties.insert(
            "model_id".to_string(),
            json!({
                "type": "string",
                "description": "Optional model ID for action='spawn' and action='send_input'. Can be 'inherit', 'primary', 'fast', or a configured model ID."
            }),
        );
        properties
    }

    pub(super) fn regular_input_schema() -> Value {
        let mut properties = Self::base_schema_properties();
        properties.insert(
            "action".to_string(),
            json!({
                "type": "string",
                "enum": ["spawn", "send_input", "cancel"],
                "description": "The action to perform."
            }),
        );
        if let Some(subagent_type) = properties.get_mut("subagent_type") {
            subagent_type["description"] =
                json!("Optional for action='spawn'. Do not provide with fork_context=true.");
        }
        properties.insert(
            "fork_context".to_string(),
            json!({
                "type": "boolean",
                "default": false,
                "description": "Optional for action='spawn'. Defaults to false. When true, do not provide subagent_type."
            }),
        );
        properties.insert(
            "agent_id".to_string(),
            json!({
                "type": "string",
                "description": "For action='spawn', Choose a meaningful unique ID matching [a-z][a-z0-9_-]{0,31}. For action='send_input' and action='cancel', use the ID chosen when the agent was spawned."
            }),
        );
        properties.insert(
            "run_in_background".to_string(),
            json!({
                "type": "boolean",
                "description": "Optional for action='spawn' and action='send_input'. Defaults to false."
            }),
        );
        json!({
            "type": "object",
            "properties": properties,
            "required": [
                "action",
                "agent_id"
            ],
            "additionalProperties": false
        })
    }

    pub(super) fn render_description(&self) -> String {
        r#"Run or manage a subagent that handles complex, multi-step tasks autonomously.

When to use:
- Delegate when a specialized subagent or separate context is likely to improve coverage, independence, or parallelism.
- Use direct tools instead for focused lookups, known paths, single symbols, or code that can be inspected with a few reads or searches.

Supported actions:
- `spawn`: create and run a new subagent. Choose a meaningful unique `agent_id`.
- `send_input`: continue an existing subagent. Provide its `agent_id` and a `prompt`. Optionally provide `model_id` to switch the subagent model for this and later turns.
- `cancel`: cancel a background subagent. Provide `agent_id`.

Two modes for action='spawn':
The two modes are mutually exclusive: do not provide `subagent_type` when `fork_context=true`.
1. With an explicit `subagent_type` (default)
  - Provide `agent_id`, `subagent_type`, and `prompt`.
  - Available types are listed in the <available_agents> section. Each type has specific capabilities and tools.
  - In this mode, the subagent does not share your context. Include all necessary background information in the prompt.
2. By forking the current context
  - Set `fork_context=true`, and provide `agent_id` and `prompt`. Do not provide `subagent_type`.
  - In this mode, the subagent inherits the full conversation history up to this point — all prior user messages, assistant responses, and tool results. You do not need to repeat information already covered in the conversation.

`prompt` writing guidelines:
- Do not put `action`, `subagent_type`, `agent_id`, or `model_id` inside the prompt string.
- Keep it under 180 lines / 16KB. For large delegations, split the work into multiple AgentSpawn calls with clear ownership.
- Pass file paths, symbols, constraints, and exact questions instead of pasting large file contents.
- Clearly tell the agent whether you expect code changes or research only (searches, file reads, web fetches, etc.), because it does not know the user's intent unless you state it.

`run_in_background` usage:
- false: Wait for the agent to finish and return its result to you.
- true: Run the agent in the background without blocking you. The response includes a `bg_task_id`; use AgentWait when you need the results.

`model_id` usage:
- Set it only when the user requests a particular model.
- Omit it to use the subagent's configured model, which may differ from your model.
- Special values: `inherit` explicitly uses the same model as yours; `primary` and `fast` use the user's configured model slots.
- For a configured model, call ListModels first and use its returned `model_id`.

Usage notes:
- Provide a clear prompt for `spawn` and `send_input` so the agent can work autonomously and return the information you need.
- The subagent inherits your workspace. If the subagent should inspect or operate on a path outside the current workspace, say that target path and scope clearly in the prompt.
- Launch independent agents concurrently when that improves coverage or latency or when the user explicitly requests it. To do this, send parallel AgentSpawn calls in a single assistant message.
- When launching multiple non-read-only subagents in parallel, assign non-overlapping scopes and outputs so their file edits, commands, or external side effects do not conflict.
- Treat subagent outputs as useful evidence, but verify details yourself before making edits or final claims that depend on exact code.
- If an agent description mentions proactive use, consider it when relevant and use your judgment.

Examples (assume "example-reviewer" is present in the agent listing):
<examples>
- Start a new specialized subagent: `{ "action": "spawn", "agent_id": "parser-review", "subagent_type": "example-reviewer", "prompt": "Inspect the parser flow in src/parser.rs and report risks, key functions, and any missing tests." }`
- Start by forking the current context: `{ "action": "spawn", "agent_id": "migration-impact", "fork_context": true, "prompt": "Using the current context, check whether the migration affects config loading. Stay read-only and report the answer with file references." }`
- Continue an existing subagent with a specific model: `{ "action": "send_input", "agent_id": "parser-review", "model_id": "fast", "prompt": "Continue from your prior parser review and focus on the error recovery paths." }`
- Cancel a background subagent: `{ "action": "cancel", "agent_id": "parser-review" }`
</examples>
"#
            .to_string()
    }
}

impl AgentSpawnTool {
    pub(super) fn agent_spawn_input_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "A meaningful and unique ID for the new agent. It must match the pattern [a-z][a-z0-9_-]{0,31}."
                },
                "prompt": {
                    "type": "string",
                    "description": "A self-contained instruction describing the objective, scope, constraints, and expected result."
                },
                "agent_type": {
                    "type": "string",
                    "description": "The type of agent to launch."
                },
                "model_id": {
                    "type": "string",
                    "description": "Optional model selection. Can be 'inherit', 'primary', 'fast', or a configured model ID."
                }
            },
            "required": ["agent_id", "prompt", "agent_type"],
            "additionalProperties": false
        })
    }

    pub(super) fn render_agent_spawn_description(&self) -> String {
        r#"Launch a new agent to work independently in the background.

Choose an `agent_type` permitted by the current system prompt. Each type has its own role and tool set.

Choose a meaningful `agent_id` for this agent. It must be unique among agents launched by you and match `[a-z][a-z0-9_-]{0,31}`.

Write a self-contained `prompt` that gives the agent everything it needs to complete the work:
- State the objective, scope, relevant paths or symbols, constraints, and expected result.
- Say whether code changes are expected or the work is read-only.
- Pass precise references instead of pasting large file contents.
- Keep the prompt under 180 lines / 16KB when practical; split broad work into focused agents with clear ownership.

The agent shares the current workspace and starts with a fresh conversation. The result includes a `bg_task_id`. Use `bg_task_id` with AgentWait to collect the result. For agents that support follow-up turns, use the requested `agent_id` with AgentSendInput; use AgentControl with `action="interrupt"` to stop active work or `action="delete"` to remove an agent subtree.

Set `model_id` only when a particular model is required. Omit it to use the agent's configured model. `inherit` selects the current model; `primary` and `fast` select the corresponding configured model slots. Call ListModels before using a configured model ID.

Independent agents can be launched together when that improves coverage or latency. Give agents that may write files non-overlapping scopes so their edits and side effects do not conflict."#
            .to_string()
    }
}

impl AgentSendInputTool {
    pub(super) fn agent_send_input_schema() -> Value {
        json!({
            "type": "object",
            "properties": {
                "agent_id": {
                    "type": "string",
                    "description": "The agent ID chosen when the agent was launched."
                },
                "prompt": {
                    "type": "string",
                    "description": "The next instruction for the agent. It may build on the agent's prior conversation."
                },
                "model_id": {
                    "type": "string",
                    "description": "Optional model selection for this and later turns. Can be 'inherit', 'primary', 'fast', or a configured model ID."
                }
            },
            "required": ["agent_id", "prompt"],
            "additionalProperties": false
        })
    }

    pub(super) fn render_agent_send_input_description(&self) -> String {
        r#"Send a new instruction to an existing agent. The instruction starts a background turn and the call returns immediately.

Use the `agent_id` chosen when the agent was launched. The agent retains its earlier conversation, so the `prompt` can refer to prior findings or ask it to continue, refine, verify, or change direction. State the new objective and expected result clearly.

The result includes a new `bg_task_id`. Use it with AgentWait to collect the result of this turn."#
            .to_string()
    }
}
