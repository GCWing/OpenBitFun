use crate::agentic::tools::framework::{Tool, ToolResult, ToolUseContext};
use crate::util::errors::{OpenBitFunError, OpenBitFunResult};
use async_trait::async_trait;
use serde_json::{json, Value};

/// TodoWrite tool - record todo items
pub struct TodoWriteTool;

impl TodoWriteTool {
    pub fn new() -> Self {
        Self
    }
}

impl Default for TodoWriteTool {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl Tool for TodoWriteTool {
    fn name(&self) -> &str {
        "TodoWrite"
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(r###"Create and manage the structured task list for the current session. Use it to keep multi-step work visible, prevent missed follow-ups, and track verification.

Use TodoWrite when:
- The task has multiple meaningful steps, files, phases, or verification actions.
- The user gives a list of tasks or explicitly asks for task tracking.
- You are entering a test/fix loop or a broad investigation that may uncover follow-up work.
- New instructions change the scope and should be reflected in the plan.

Skip TodoWrite when:
- The task is a single obvious action or a short conversational answer.
- Tracking would add noise without improving reliability.

Management rules:
- Keep items specific and actionable.
- Keep exactly one item in_progress while actively working; mark it completed as soon as it is finished.
- Do not mark a task completed if implementation is partial, tests are failing, or a blocker remains.
- Add or remove items as the work changes so the list stays accurate.
- Include verification as a task when the result depends on code changes, tool output, external sources, UI state, or generated files.

Task states:
- pending: not started
- in_progress: currently being worked on
- completed: fully done

Each item must include:
- id: stable unique identifier
- content: imperative description of the work
- status: pending, in_progress, or completed
"###.to_string())
    }

    fn short_description(&self) -> String {
        "Create and update the session todo list.".to_string()
    }

    fn input_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "todos": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": {
                                "type": "string",
                                "description": "Unique identifier for the todo item"
                            },
                            "content": {
                                "type": "string",
                                "minLength": 1,
                                "description": "The imperative form describing what needs to be done"
                            },
                            "status": {
                                "type": "string",
                                "enum": [
                                    "pending",
                                    "in_progress",
                                    "completed"
                                ],
                                "description": "Current status of the todo item"
                            }
                        },
                        "required": [
                            "id",
                            "content",
                            "status"
                        ],
                        "additionalProperties": false
                    },
                    "description": "The updated todo list"
                }
            },
            "required": ["todos"],
            "additionalProperties": false
        })
    }

    fn output_schema(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "success": {"type": "boolean"},
                "count": {"type": "integer"},
                "summary": {"type": "string"},
                "stats": {
                    "type": "object",
                    "properties": {
                        "completed": {"type": "integer"},
                        "in_progress": {"type": "integer"},
                        "pending": {"type": "integer"}
                    },
                    "required": ["completed", "in_progress", "pending"],
                    "additionalProperties": false
                }
            },
            "required": ["success", "count", "summary", "stats"],
            "additionalProperties": false
        })
    }

    fn is_readonly(&self) -> bool {
        true
    }

    fn is_concurrency_safe(&self, _input: Option<&Value>) -> bool {
        true
    }

    async fn call_impl(
        &self,
        input: &Value,
        _context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        // Parse todos array
        let todos = input
            .get("todos")
            .and_then(|v| v.as_array())
            .ok_or(OpenBitFunError::validation("Missing required field: todos"))?;

        let mut processed_todos = Vec::new();
        for todo in todos {
            let mut todo_obj = todo.clone();
            if let Some(obj) = todo_obj.as_object_mut() {
                if !obj.contains_key("status") {
                    return Err(OpenBitFunError::validation(
                        "Todo item missing status field",
                    ));
                }
                if !obj.contains_key("content") {
                    return Err(OpenBitFunError::validation(
                        "Todo item missing content field",
                    ));
                }
                // If no id, generate a new one
                if !obj.contains_key("id") {
                    let uuid = uuid::Uuid::new_v4().to_string();
                    let short_id = uuid.split('-').next().unwrap_or("todo");
                    let new_id = format!("todo_{}", short_id);
                    obj.insert("id".to_string(), json!(new_id));
                }
            }
            processed_todos.push(todo_obj);
        }

        let todo_count = processed_todos.len();
        let mut status_counts = [0; 3];
        processed_todos.iter().for_each(|t| {
            let status = t.get("status").and_then(|s| s.as_str()).unwrap_or("");
            match status {
                "pending" => status_counts[0] += 1,
                "in_progress" => status_counts[1] += 1,
                "completed" => status_counts[2] += 1,
                _ => {}
            }
        });

        let summary = format!(
            "Updated todo list with {} tasks (completed: {}, in_progress: {}, pending: {})",
            todo_count, status_counts[2], status_counts[1], status_counts[0]
        );

        let result = json!({
            "success": true,
            "todos": processed_todos,
            "merge": false,
            "count": todo_count,
            "summary": summary,
            "stats": {
                "completed": status_counts[2],
                "in_progress": status_counts[1],
                "pending": status_counts[0]
            }
        });

        Ok(vec![ToolResult::Result {
            data: result,
            result_for_assistant: Some(summary),
            image_attachments: None,
        }])
    }
}
