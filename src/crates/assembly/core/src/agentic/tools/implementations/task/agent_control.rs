use super::*;

const AGENT_SPAWN_FIELDS: &[&str] = &["agent_id", "prompt", "agent_type", "model_id"];
const AGENT_SEND_INPUT_FIELDS: &[&str] = &["agent_id", "prompt", "model_id"];

fn input_object<'a>(
    input: &'a Value,
    tool_name: &str,
    allowed_fields: &[&str],
) -> OpenBitFunResult<&'a Map<String, Value>> {
    let object = input
        .as_object()
        .ok_or_else(|| OpenBitFunError::tool(format!("{tool_name} input must be an object")))?;
    if let Some(field) = object
        .keys()
        .find(|field| !allowed_fields.contains(&field.as_str()))
    {
        return Err(OpenBitFunError::tool(format!(
            "{tool_name} does not accept field '{field}'"
        )));
    }
    Ok(object)
}

fn required_string(
    object: &Map<String, Value>,
    field: &str,
    tool_name: &str,
) -> OpenBitFunResult<String> {
    let value = object
        .get(field)
        .ok_or_else(|| OpenBitFunError::tool(format!("{field} is required for {tool_name}")))?
        .as_str()
        .ok_or_else(|| OpenBitFunError::tool(format!("{field} must be a string")))?
        .trim();
    if value.is_empty() {
        return Err(OpenBitFunError::tool(format!(
            "{field} is required for {tool_name}"
        )));
    }
    Ok(value.to_string())
}

fn optional_string(object: &Map<String, Value>, field: &str) -> OpenBitFunResult<Option<String>> {
    match object.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => {
            let value = value
                .as_str()
                .ok_or_else(|| OpenBitFunError::tool(format!("{field} must be a string")))?
                .trim();
            Ok((!value.is_empty()).then(|| value.to_string()))
        }
    }
}

fn insert_optional_model_id(task_input: &mut Value, model_id: Option<String>) {
    if let Some(model_id) = model_id {
        task_input["model_id"] = Value::String(model_id);
    }
}

fn validate_task_input(task_input: OpenBitFunResult<Value>, tool_name: &str) -> ValidationResult {
    let task_input = match task_input {
        Ok(task_input) => task_input,
        Err(error) => return AgentExecutionTool::invalid_input(error.to_string()),
    };
    if let Err(error) = AgentExecutionTool::parse_invocation(&task_input, false) {
        return AgentExecutionTool::invalid_input(error.to_string());
    }
    if let Some(result) = AgentExecutionTool::validate_prompt_size_for_tool(&task_input, tool_name)
    {
        return result;
    }
    ValidationResult::default()
}

impl Default for AgentSpawnTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSpawnTool {
    pub fn new() -> Self {
        Self
    }

    pub(super) fn task_input(input: &Value) -> OpenBitFunResult<Value> {
        let object = input_object(input, "AgentSpawn", AGENT_SPAWN_FIELDS)?;
        let agent_id = required_string(object, "agent_id", "AgentSpawn")?;
        let raw_agent_id = object
            .get("agent_id")
            .and_then(Value::as_str)
            .expect("required_string already verified agent_id is a string");
        crate::agentic::coordination::validate_agent_id(raw_agent_id)?;
        let prompt = required_string(object, "prompt", "AgentSpawn")?;
        let agent_type = required_string(object, "agent_type", "AgentSpawn")?;
        let model_id = optional_string(object, "model_id")?;
        let mut task_input = json!({
            "action": "spawn",
            "agent_id": agent_id,
            "prompt": prompt,
            "subagent_type": agent_type,
            "run_in_background": true
        });
        insert_optional_model_id(&mut task_input, model_id);
        Ok(task_input)
    }

    pub(super) fn render_results(results: Vec<ToolResult>) -> Vec<ToolResult> {
        results
            .into_iter()
            .map(|result| match result {
                ToolResult::Result {
                    data,
                    result_for_assistant,
                    image_attachments,
                } => {
                    let Some(agent_id) = data.get("agent_id").and_then(Value::as_str) else {
                        return ToolResult::Result {
                            data,
                            result_for_assistant,
                            image_attachments,
                        };
                    };
                    let Some(bg_task_id) = data.get("bg_task_id").and_then(Value::as_str) else {
                        return ToolResult::Result {
                            data,
                            result_for_assistant,
                            image_attachments,
                        };
                    };
                    ToolResult::Result {
                        data: json!({
                            "status": "started",
                            "agent_id": agent_id,
                            "bg_task_id": bg_task_id
                        }),
                        result_for_assistant: Some(format!(
                            "Agent started successfully in the background.\nbg_task_id: \"{bg_task_id}\"\nYou can continue with other work while the agent runs. Use AgentWait with this bg_task_id when you need the result."
                        )),
                        image_attachments,
                    }
                }
                other => other,
            })
            .collect()
    }
}

#[async_trait]
impl Tool for AgentSpawnTool {
    fn name(&self) -> &str {
        "AgentSpawn"
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self.render_agent_spawn_description())
    }

    fn short_description(&self) -> String {
        "Launch an agent to work independently in the background.".to_string()
    }

    fn input_schema(&self) -> Value {
        Self::agent_spawn_input_schema()
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn is_concurrency_safe(&self, input: Option<&Value>) -> bool {
        input
            .and_then(|input| Self::task_input(input).ok())
            .is_some_and(|task_input| {
                AgentExecutionTool::new().is_concurrency_safe(Some(&task_input))
            })
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        AgentExecutionTool::new().permission_intents(&Self::task_input(input)?, context)
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        input
            .get("agent_id")
            .and_then(Value::as_str)
            .map(|agent_id| {
                if options.verbose {
                    format!("Launching agent: {agent_id}")
                } else {
                    format!("Agent: {agent_id}")
                }
            })
            .unwrap_or_else(|| "Launching agent".to_string())
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        validate_task_input(Self::task_input(input), self.name())
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let results = AgentExecutionTool::new()
            .call_task_impl(&Self::task_input(input)?, context)
            .await?;
        Ok(Self::render_results(results))
    }
}

impl Default for AgentSendInputTool {
    fn default() -> Self {
        Self::new()
    }
}

impl AgentSendInputTool {
    pub fn new() -> Self {
        Self
    }

    pub(super) fn task_input(input: &Value) -> OpenBitFunResult<Value> {
        let object = input_object(input, "AgentSendInput", AGENT_SEND_INPUT_FIELDS)?;
        let agent_id = required_string(object, "agent_id", "AgentSendInput")?;
        let prompt = required_string(object, "prompt", "AgentSendInput")?;
        let model_id = optional_string(object, "model_id")?;
        let mut task_input = json!({
            "action": "send_input",
            "agent_id": agent_id,
            "prompt": prompt,
            "run_in_background": true
        });
        insert_optional_model_id(&mut task_input, model_id);
        Ok(task_input)
    }

    pub(super) fn render_results(results: Vec<ToolResult>) -> Vec<ToolResult> {
        results
            .into_iter()
            .map(|result| match result {
                ToolResult::Result {
                    data,
                    result_for_assistant,
                    image_attachments,
                } => {
                    let Some(agent_id) = data.get("agent_id").and_then(Value::as_str) else {
                        return ToolResult::Result {
                            data,
                            result_for_assistant,
                            image_attachments,
                        };
                    };
                    let Some(bg_task_id) = data.get("bg_task_id").and_then(Value::as_str) else {
                        return ToolResult::Result {
                            data,
                            result_for_assistant,
                            image_attachments,
                        };
                    };
                    ToolResult::Result {
                        data: json!({
                            "status": "started",
                            "agent_id": agent_id,
                            "bg_task_id": bg_task_id
                        }),
                        result_for_assistant: Some(format!(
                            "Instruction sent successfully. The agent is working in the background.\nbg_task_id: \"{bg_task_id}\"\nYou can continue with other work while the agent runs. Use AgentWait with this bg_task_id when you need the result."
                        )),
                        image_attachments,
                    }
                }
                other => other,
            })
            .collect()
    }
}

#[async_trait]
impl Tool for AgentSendInputTool {
    fn name(&self) -> &str {
        "AgentSendInput"
    }

    fn manages_own_execution_timeout(&self) -> bool {
        true
    }

    async fn description(&self) -> OpenBitFunResult<String> {
        Ok(self.render_agent_send_input_description())
    }

    fn short_description(&self) -> String {
        "Send an instruction to an existing agent.".to_string()
    }

    fn input_schema(&self) -> Value {
        Self::agent_send_input_schema()
    }

    fn is_readonly(&self) -> bool {
        false
    }

    fn permission_intents(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<PermissionIntent>> {
        AgentExecutionTool::new().permission_intents(&Self::task_input(input)?, context)
    }

    fn render_tool_use_message(&self, input: &Value, options: &ToolRenderOptions) -> String {
        input
            .get("agent_id")
            .and_then(Value::as_str)
            .map(|agent_id| {
                if options.verbose {
                    format!("Sending input to agent: {agent_id}")
                } else {
                    format!("Agent input: {agent_id}")
                }
            })
            .unwrap_or_else(|| "Sending input to agent".to_string())
    }

    async fn validate_input(
        &self,
        input: &Value,
        _context: Option<&ToolUseContext>,
    ) -> ValidationResult {
        validate_task_input(Self::task_input(input), self.name())
    }

    async fn call_impl(
        &self,
        input: &Value,
        context: &ToolUseContext,
    ) -> OpenBitFunResult<Vec<ToolResult>> {
        let results = AgentExecutionTool::new()
            .call_task_impl(&Self::task_input(input)?, context)
            .await?;
        Ok(Self::render_results(results))
    }
}
